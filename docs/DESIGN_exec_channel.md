# DESIGN — the EXEC CHANNEL (remote exerciser over the cloud path)

**Status: SPEC ONLY — and UNDERSPECIFIED (user ruling, 2026-08-08).** Rung 1's code was written and then torn
down the same day; nothing is built. Do not write more code against this document until the open items in §12 are
closed, above all the §7.0.2 credential fork, which decides whether the transport is `/objects` at all. The
teardown and its lesson are recorded in `BUILD_ARC_exec_channel.md` §Teardown. Written 2026-08-08 at v2.74.2104 after the user ruled on the one
question that matters (§1.2). The ladder in §10 is the build order; §11 records what stays unbuilt and why.

**Credential model RULED 2026-08-08 (RULING 5, §7.0.1): option C — enrollment.** The loop signs in with the
owner's login; the cloud mints a distinct, labelled machine principal bound to the same account. Owner-only
creation preserved; attribution, single-machine revocation and path scoping kept. Options A and B recorded with
the reasons, and with B's retrofit cost named.

**Revised 2026-08-08 after two adversarial review passes.** Findings marked **REVIEW FIX** inline. The four that
changed the design rather than tightening it: the listing endpoint the first draft called does not exist (§3.0,
forced the mailbox shape) · the loop cannot authenticate to the cloud at all, and the credential that would fix
that grants record access as a side effect (§7.0 — new EXC-C, now the long pole) · the seen-set had to be
persisted or `reload` becomes an infinite loop (§4.8) · the feature had no way to be graded by the loop it
serves (§13). Pass 2 also caught the disclosure copy asserting a guarantee no mechanism yet enforces (§6.2).

Companions: `RESEARCH_auto_glf.md` (the loop this serves, §9.2 the lease port) · `DESIGN_cloud_logs.md` (the
shipping path this deliberately does NOT invert) · `tools/exercise/exercise.cjs` (the local exerciser this
generalises) · `background/handlers/exerciser.js` (the handlers it reuses unchanged).

---

## 1. The property, and the ruling

### 1.1 The finding

The auto-glf loop is a verification robot with eyes and no hands. It reads fleet traces and grades them, but it
cannot cause the event it grades. Measured cost: `v2.74.2009` has sat open since 2026-08-06 waiting for one
human to type one message; on 2026-08-08 nine consecutive ticks reported "waiting on a human" with nothing
gradeable and nothing to build. The `[auto]` slot in every test's ACTION checklist — the slot that says *the loop
can do this itself* — has never been read by anything (`CRON_PROMPT.md` still-owed item 5).

A local answer exists and works: `tools/exercise/exercise.cjs` drives Chrome over the remote-debugging port and
drove four of four historical stuck tests to a graded PASS. It is unusable in practice because it requires Chrome
to have been started with `--remote-debugging-port=9222` — verified closed on this machine — and that port lets
**any** local process drive the profile holding the live logged-in sessions the connectors borrow.

### 1.2 The decision (user, 2026-08-08)

> *"Everything above is mechanics. The decision is one property: does the arrival of a remote object, by itself,
> cause the browser to act? Agreed, this will be dev gated. Any user enabling dev would be explicitly informed of
> implications."*

**RULING 1 — arrival MAY cause action, but only inside an explicitly armed dev instance.** The capability ships
in the extension; it is inert on every install that has not been armed, and arming is a deliberate, disclosed,
expiring act (§6).

**RULING 2 — the disclosure is part of the feature, not documentation.** Enabling dev mode must state, in the UI,
what the exec channel makes possible. An undisclosed remote-drive capability is the surface the dev-bridge trust
rules exist to prevent (`CLAUDE.md`, "Trust rules for the dev-bridge").

### 1.3 What this does NOT change

The local exerciser's refusals carry over verbatim and are re-stated as rulings here, because a network makes
each of them stronger, not weaker:

- **No `eval`, ever.** Two verbs. *"The moment this accepts arbitrary expressions it stops being an exerciser and
  becomes 'run any JS in the user's logged-in browser', and it will be used that way."*
- **The write belt is not duplicated.** An exercised ask that routes to a non-GET write is blocked by the
  existing confirm gate exactly as a typed one is. A second copy here would rot independently of the real gate.
- **An exercised ask is indistinguishable from a typed one TO THE ROUTER** (it goes through the front door) and
  **distinguishable IN THE TRACE** (§7.3). Both halves are required.

---

## 2. Why the sync path and not the logging path

The obvious reading of "invert the logging path" is wrong. `Logger` ring → `CloudLogShipper` → API → CloudWatch →
hourly exporter → git → `git pull` is one-way by construction, and the git hop alone puts it minutes behind. A
command channel there is a new pipe built beside an existing one.

The **cloud object path is already bidirectional and already polls**. What follows is verified, not assumed:

| Piece | Where | State |
|---|---|---|
| Bound per-install identity | `/identity/me`, `/identity/bind`, `/identity/bind/challenge` (`orchard-cloud/lambda/api/index.js:1500`) | live |
| Object store | `/objects` GET/PUT/DELETE, `/objects/batch`, presign-put | live |
| Credential hygiene | `cloudRequest` only; no AWS creds client-side (`Services/Cloud/CloudLogShipper.js` header ruling) | enforced |
| Auth pause semantics | 401/403 → pause until next auth success | enforced |
| A ≤60 s client poll | `orchard-sync` alarm, `period = max(1, ceil(syncIntervalSec/60))` (`background.js:238`) → `runSync()` → `listCloudChanges()` | live |
| Durable queue across SW death | `SyncEngine` outbox persisted to `chrome.storage` | live |
| **The command handlers** | `DEV_RUN_ASK`, `DEV_RELOAD_EXTENSION` (`background/handlers/exerciser.js`) | **live, transport-agnostic** |

That last row is why this is a small feature. `DEV_RUN_ASK` is a service-worker handler that forwards to the
panel via `DEV_ASK_INJECT` and already answers `panel-closed` when there is nowhere to dispatch. It does not care
who called it. Today its only caller is a local CDP `evaluate`; a cloud dispatcher calls the **same function**.

### 2.1 RULING 3 — reuse the transport, NOT the record-sync pipeline

Commands must not enter `SyncEngine`. `SyncKind` is a typed list of *records* (`ground`, `fragment`, `workflow`,
`goalMemory`, …) that land in the local cache, the outbox, and conflict resolution. A command is not a record: it
is single-use, expiring, and must never be cached, merged, re-applied on rebuild, or resurrected by a bootstrap
dirty-scan. The exec channel therefore uses `cloudRequest` + `/objects` **directly**, on its own alarm, and adds
no `SyncKind`. This also keeps a failure in the exec channel structurally unable to corrupt record sync.

### 2.2 The precedent, stated honestly

`workflow` and `goalMemory` already sync DOWN. Executable content and the LEARNED rules that drive the classifier
already arrive from the cloud on a ≤60 s poll. So remote content already shapes behaviour — but a synced workflow
**waits for a trigger**; it does not fire on arrival. That is the line §1.2 authorises crossing, and the arming
gate is what keeps the crossing scoped to instances that opted in.

---

## 3. The command object

### 3.0 The mailbox, and why it is not a listing

**REVIEW FIX (pass 1).** The first draft specified `GET /objects?prefix=exec/<installId>/`. **That endpoint does
not exist.** `handleListObjects` takes `since` + `limit` (`orchard-cloud/lambda/api/index.js:495`) — it is a
changes feed, not a prefix listing. Polling it would mean carrying a cursor and filtering client-side, i.e.
building a second sync engine to fetch one small object.

The API reality forces a better shape. **One deterministic object per install:**

```
exec/<installId>            → the MAILBOX  (client GETs this exact path, nothing else)
exec-result/<installId>     → the RESULTS  (client PUTs; the loop reads)
```

`GET /objects/{path}` exists and is a single fetch. The mailbox holds a bounded queue:

```jsonc
{ "v": 1, "queue": [ <command>, … ] }   // MAILBOX_MAX = 5; the loop refuses to enqueue past it
```

Consequences, all of them good: one GET per poll regardless of queue depth · no cursor state to lose across an
MV3 SW death · "one command per poll" falls out of taking `queue[0]` · **revocation is a normal write** — the
loop rewrites or deletes the mailbox and anything not yet picked up is gone (§4.10).

### 3.1 Addressing

Scoped to the **install**, not the identity. One identity commonly has several installs — this machine runs
Orchard in three Chrome profiles, all answering to the same extension id, and the local exerciser already
*refuses to guess* between them (`tools/exercise/exercise.cjs`, v2.74.1957: taking the first match could reload
the right extension while dispatching the ask into the wrong instance, producing a silent no-op). Remotely there
is no console to refuse into, so targeting must be explicit and verified client-side.

**Where `installId` comes from (REVIEW FIX, pass 1).** It already exists: `cloudlogs:installId` in
`chrome.storage.local`, minted lazily and cached (`Services/Cloud/CloudLogShipper.js:92-100`). Two properties
follow, and both are load-bearing:

- It is **per Chrome profile** (`storage.local` is), so it is exactly the granularity targeting needs.
- It is **owned by the log shipper and minted only on the shipping path.** An instance that has never shipped
  logs has no id — and, symmetrically, the loop learns install ids *from the fleet log stream*
  (`pk_…/ins_…`). So **an instance that does not ship logs is not addressable**, which is a desirable default
  and should be stated rather than discovered.
- **Owed by EXC-0:** hoist the getter out of `CloudLogShipper` into a shared identity module. An exec channel
  that reads another feature's private storage key inherits that feature's lifecycle by accident — exactly the
  "the doc claimed a capability the mechanism never had" class this repo logged at v2.74.2104.

### 3.2 Shape

```jsonc
{
  "v": 1,
  "cmdId": "<uuid>",           // also the nonce — single-use (§4.4)
  "installId": "<ins_…>",      // MUST equal this instance's own id, else ignored (not an error — not ours)
  "verb": "ask" | "reload",    // closed set (§4.2)
  "arg":  "<ask text>",        // absent for reload; clipped to ASK_MAX_CHARS
  "issuedBy": "<lane tag>",    // provenance for the trace — never trusted for authorization
  "issuedAt": "<ISO>",
  "expiresAt": "<ISO>",        // MUST be within EXEC_TTL of issuedAt (§4.3)
  "reason": "<test id / why>"  // free text, logged, ≤120 chars
}
```

### 3.3 Result

Written back by the client to `exec-result/<installId>/<cmdId>`:

```jsonc
{
  "cmdId": "…", "at": "<ISO>", "outcome": "dispatched"|"refused"|"expired"|"replayed"|"disarmed"|"panel-closed",
  "detail": "<conversationId | refusal reason>", "version": "<manifest version at execution>"
}
```

**The result is the ack.** A loop that cannot see a result must treat the command as never delivered — the same
"the push IS the delivery" discipline the bus already runs on. `version` is present so a grader can tell which
build actually executed, which is the failure that wasted the 17:20Z grade on 2026-08-08.

---

## 4. The safety envelope

Seven rules. Each is a refusal the client makes locally; none depends on the cloud being trustworthy.

1. **DISARMED IS INERT.** `settings:execChannel` defaults `'off'`. When off, the poll alarm is not created, no
   object is fetched, and the dispatcher is never reached. Not "fetched and ignored" — **not fetched**.
2. **CLOSED VERB SET.** `ask` and `reload`. An unknown verb is refused and logged; there is no extension point,
   no `eval`, no passthrough. Adding a verb is a spec change, not a config change.
3. **TTL.** A command whose `expiresAt` has passed, or whose `expiresAt - issuedAt` exceeds `EXEC_TTL`
   (proposed: 10 min, matching `EXERCISE_QUEUE_KEY`'s existing bound), is refused as `expired`. The existing
   queue comment states the reason: *"a stale queue must never wake up days later and drive a browser nobody is
   watching."*
4. **SINGLE USE.** `cmdId` is recorded in a local seen-set on first sight and refused as `replayed` thereafter.
   Without this a command object left in the store re-fires on every poll forever. The seen-set is bounded and
   evicts by age (≥ 2× `EXEC_TTL`).
5. **TARGET MATCH.** `installId` must equal this instance's own. A mismatch is silently ignored — it is another
   instance's mail, not an error.
6. **ARMING EXPIRES.** An armed instance auto-disarms after `ARM_TTL` (proposed: 8 h) and on extension update.
   Arming is a session, not a state. A forgotten arm is the most likely way this becomes a standing hole.
7. **THE WRITE GATE IS UNTOUCHED.** Non-GET writes still require confirmation. This channel changes who *asks*,
   never who *approves*.

**Added by review (pass 1 + 2). Each of these is a hole the first draft left open.**

8. **THE SEEN-SET IS PERSISTED, NOT IN MEMORY.** MV3 kills the service worker constantly, and the `reload` verb
   kills it *on purpose*. An in-memory seen-set is therefore empty at exactly the moment rule 4 is load-bearing,
   and the reload command re-fires on the next poll — forever, on a timer, in a browser nobody is watching. The
   seen-set lives in `chrome.storage.local`, written **before** the handler is invoked (§5).
9. **THE CLIENT'S CLOCK DECIDES.** `issuedAt`/`expiresAt` are written by a different machine, whose clock may
   differ by minutes. Expiry is evaluated against the **client's** `Date.now()`; `issuedAt` is advisory
   provenance only. A command whose `issuedAt` is more than `MAX_SKEW` (proposed: 5 min) in the client's future
   is refused as `expired` rather than honoured — a future-dated command is either a broken clock or a replay
   attempt, and neither should run.
10. **REVOCATION IS A WRITE, AND IT IS ONE-WAY.** Rewriting or deleting the mailbox cancels anything not yet
    picked up. Nothing cancels a command already dispatched — a turn in flight is a normal turn. Say this
    plainly rather than implying an undo exists.
11. **THE HUMAN AT THE KEYBOARD OUTRANKS THE CHANNEL.** `stop` halts a remote-driven turn exactly as it halts a
    typed one (the STOP hoist outranks the turn lock by design), and disarming is one click and takes effect
    before the next poll. No remote command may re-arm; arming is only ever a local act.
12. **A FAILED COMMAND IS NOT RETRIED BY DEFAULT** *(added by the arc review, 2026-08-08 — this was missing from
    both documents)*. Single-use (rule 4) means the client never re-runs a command; the question this leaves open
    is whether the **issuer** re-issues. It must not do so blindly: a loop that re-writes a mailbox every tick
    against a closed panel hammers it forever and fills the results store with identical refusals. The rule:
    an issuer may re-issue a command **at most `MAX_REISSUE` times (proposed: 2)**, only for outcomes that are
    plausibly transient (`panel-closed`, `disarmed`), never for `refused`/`expired`/`replayed`, and it must stop
    entirely once the test it serves has a verdict. A `panel-closed` result is an **INCONCLUSIVE precondition**,
    not a failure to retry around — the same reading the loop already applies to unmet SCOPE.
13. **`reload` PRESERVES ARMING; A VERSION CHANGE ENDS IT.** Rule 6 disarms on update — but `reload` restarts
    the worker without changing the version, and if that disarmed, the channel's most useful verb would brick
    the channel. Arming state is read from storage on boot; the alarm is re-created there (`chrome.alarms`
    persist across SW restarts natively, the property `fleet-sweep` already relies on).

---

## 5. The dispatcher

```
alarm (armed only, ≥60s)
  → GET /objects/exec/<installId>              // ONE fetch, deterministic path (§3.0)
  → cmd = queue[0]                             // oldest first, one per poll
  → validateExecCommand(cmd, {installId, now, seenSet, armed})   // PURE — Core/execCommand.js
  → mark cmdId SEEN + write exec-result/…      // ← BEFORE the handler. Non-negotiable (§5.1)
  → ok:      call the EXISTING handler (DEV_RUN_ASK | DEV_RELOAD_EXTENSION)
     refused: no handler call
  → log EXEC ▸ either way
```

### 5.1 The ordering rule (the single most dangerous line in the feature)

Mark-seen and write-result happen **before** the handler runs, not after. For `ask` this costs a little
accuracy — a command marked done that then fails to dispatch reports `dispatched` optimistically, which is why
the result records the panel's actual answer as a second write when one arrives. For `reload` it is the whole
ballgame: `chrome.runtime.reload()` tears down the worker mid-call, so any bookkeeping scheduled *after* it
never happens. Result-after-reload is an infinite reload loop. Rules 4 and 8 only hold if this ordering holds.

All decision logic lives in a pure `Core/execCommand.js` so the envelope is unit-testable without a network, a
browser, or a signed-in identity — the same split that lets `Core/logShipping.js` carry the shipper's decisions.
The Chrome-facing half does transport and nothing else.

**`reload` is special**: `chrome.runtime.reload()` tears down the worker mid-flight. The existing handler already
answers before restarting; the exec dispatcher must therefore write the result **and** mark the cmdId seen
*before* invoking it, or the command re-fires on the next poll after every reload — an infinite reload loop, on a
timer, in a browser nobody is watching. This is the single most dangerous line in the feature.

---

## 6. Arming and disclosure

### 6.1 The setting

`settings:execChannel` — `'off'` (default) | `'armed'`, with `armedAt`. Dev-gated: not rendered outside dev mode.
Kill-switch semantics mirror `settings:cloudLogs`: flipping to `'off'` clears the alarm and drops any pending
work immediately.

### 6.2 The disclosure (RULING 2)

Enabling dev mode must present, and require acknowledgement of, text to this effect — plain, specific, no
euphemism:

> **Dev mode enables remote control of this browser.**
> While armed, this extension will periodically fetch commands from your Orchard cloud account and run them here
> without asking. A command can send a message to the agent as if you typed it, or restart the extension.
> Commands can only come from your own signed-in account, expire after 10 minutes, and run once. Actions that
> create or change records still require your confirmation. Arming turns itself off after 8 hours, and `stop`
> halts a remote-driven turn exactly like one you typed.
> **Do not enable this on a browser holding accounts you would not hand to your build loop.**

The last line is the honest one. The sessions this browser holds are the sessions the connectors ride.

**REVIEW FIX (pass 2) — do not ship a claim the mechanism does not back.** *"Commands can only come from your own
signed-in account"* is currently **aspirational**: it is true only once §7.0's path-scoped credential exists. Ship
that sentence before RULING 4 is enforced and the disclosure is doing the exact thing this repo logged at
v2.74.2104 — prose asserting a capability the mechanism never had, discovered only when someone tried to rely on
it. **Gate: EXC-2 may not land before EXC-C.** If the credential work slips, the copy must be weakened to
describe what is actually enforced, not what is intended.

### 6.3 What is logged

Every fetch cycle that finds work, every refusal with its reason, and every dispatch, as `EXEC ▸` lines — the
marker family the existing handlers already use. Per invariant #1, **`EXEC ▸` must be added to `_DECISION_RE`**
(`studio.js`) in the same change, or a remote-driven turn is structurally invisible to a decisions download.

---

## 7. The loop side

### 7.0 THE PREREQUISITE THE FIRST DRAFT MISSED — the loop cannot authenticate

**REVIEW FIX (pass 2), and it is the long pole.** §7.1 of the first draft said "a lane without the exec lease may
not write an exec object," which quietly assumed a lane *can* write one. **It cannot.** Every route in
`lambda/api/index.js` goes through `requireOrchardUser` → a **Cognito JWT authorizer**. The only `x-api-key` in
the file is the *Anthropic upstream* key used by the LLM proxy, not a client credential. The extension
authenticates through `CloudTokenStore` (a browser sign-in session); a node CLI on a build machine has no such
session and no way to mint one today.

So the ladder as first written was unbuildable from EXC-5 onward. The channel needs a **machine credential**,
and that is cloud work, not extension work.

**And the credential's blast radius exceeds the two verbs.** A token that can `PUT /objects/exec/<installId>`
under the user's identity can, with the same authority, read and write `grounds`, `workflows`, and `goalMemory` —
the records that already sync DOWN (§2.2). A stolen loop credential is therefore not "can send two kinds of ask";
it is "can read the user's synced data, and can inject a workflow that later runs on a trigger." That is a
materially larger hole than the exec channel itself, and it would be created by the exec channel.

**RULING 4 — the loop's credential MUST be path-scoped.** Write access limited to `exec/<installId>`, read access
limited to `exec-result/<installId>`. No record paths. If the authorizer cannot express that scope, the scoping
must be enforced server-side in the handler before EXC-5 lands. A full-authority machine token is not an
acceptable interim: it converts a dev-gated remote-drive into a standing data-exfiltration path, and no arming
gate on the client can constrain it, because it never touches the client.

This is now **EXC-C** in the ladder, and it blocks EXC-5/6.

### 7.0.1 EXC-C, concretely — and it is SMALLER than pass 2 estimated

A closer read of the stack (2026-08-08, after the review) revises the size **down from large to small/medium**.
Three facts do it:

1. **The extension's Cognito client is a public OAuth client** — auth-code flow, no secret, scopes `email`
   `openid`, **`RefreshTokenValidity: 30` days** (`capture/cognito/…-client-qp5tn5fsmgfruvjs20hcs3hkg.json`). A
   CLI can therefore hold a refresh token from a one-time human sign-in. No new client is strictly required.
2. **Auth funnels through ONE choke point.** `requireOrchardUser` (`lambda/api/index.js:166`) is called 26
   times and already returns a structured `{orchardUserId, claims}`. Adding a principal kind is one field.
3. **Object paths funnel through ONE scope helper.** `userScope(orchardUserId)` (`:183`) builds every personal
   S3 prefix and DDB key. The path guard has exactly one place to live.

**RULING 5 (user, 2026-08-08) — ENROLLMENT, option C.** The user proposed that the exerciser simply reuse the
install's own login: it works today, it needs no cloud change, and it satisfies a real requirement —
*"only the owner of the instance will be able to instantiate an exerciser."* Three options were weighed:

| | Who can create one | Attributable to a machine | Revocable alone | Scopable |
|---|---|---|---|---|
| **A** copy the browser's refresh token to the build machine | owner | no | no | no |
| **B** the loop signs in **as** the owner (its own token, same `sub`) | owner | no | no | no |
| **C** the loop signs in **with** the owner's login; the cloud mints a **distinct machine principal** bound to the same `orchardUserId` | owner | **yes** | **yes** | **yes** |

**C is chosen.** The owner-only requirement is preserved in full — enrolling still requires the owner's
credentials, so no third party can stand up an exerciser. What changes is only what comes *out* of that sign-in:
a distinct principal rather than a second copy of the user.

Why not B, stated fairly — B is not unsafe, and the "new data reaches someone new" framing of an earlier draft
was **too strong**: everything the loop could touch is already the owner's. The accurate objection is narrower —
B is not a new *authorization* surface, it is a new *credential location*, and it costs three things:

1. **Attribution.** Under B the loop *is* the user at the cloud's only enforcement point (same `sub` → same
   identity record). The `issuedBy` lane tag still exists but is the caller describing itself — a label, not
   evidence. This directly defeats the user's own stated goal of tracking activity origin.
2. **Revocation granularity.** One shared login means one lever: invalidate the account's sessions, which signs
   out the browser and every other machine too. A single lost laptop cannot be cut off.
3. **Scoping becomes impossible, not merely unbuilt.** RULING 4's guard works by distinguishing principals at
   `requireOrchardUser`; identical `sub`s cannot be distinguished. **"Same credentials" and "scoped access" are
   mutually exclusive** — the choice is one or the other.

**A is rejected outright**: two holders of one refresh token invalidate each other's sessions, so the browser
would sign out mid-run. If B is ever taken as a fallback, the loop must perform its OWN sign-in and hold its own
token — never a copy of the browser's.

**B as fallback, with its retrofit cost named:** shipping B and adding the machine principal later means
**re-enrolling every machine**, because the credential each already holds is the thing being replaced. Acceptable
as a deliberate call; not acceptable as a drift.

### The enrollment ceremony

```
$ node tools/exercise/exercise.cjs enroll
  → opens the owner's sign-in once (auth-code flow, same public client as the extension)
  → cloud binds a NEW sub → the SAME orchardUserId, kind='machine', label='<hostname>'
  → the machine stores its own refresh token locally and renews itself (30-day validity)
```

One command, once per machine. Thereafter the loop runs unattended, every command it writes is attributable to
that machine, and removing one machine is deleting one principal.

**Why self-minting is impossible, and why that is the point.** A credential is a claim an authority makes about
the holder; a self-issued one proves nothing, because anything could issue the identical claim. The first proof
must therefore come from outside — which is exactly the owner-only property the user wants. Enrollment is not an
obstacle to owner-only creation; it is the mechanism that *makes* origin tracking meaningful, because a forgeable
identity turns an audit log into a record of what the caller chose to say about itself.

**The cheap, correct mechanism** — no Cognito change at all:

- Enrollment (above) yields the machine its own Cognito `sub`, bound to the **same** `orchardUserId` as the
  browser. `getIdentityRecord(sub)` already resolves per-`sub`, so the two principals are distinguishable at the
  choke point **today**, with no Cognito reconfiguration.
- That identity record carries `kind: 'machine'` and a human `label` (the hostname), so the audit answers *which
  machine*, not merely *a machine*.
- `requireOrchardUser` returns both fields; object routes refuse a machine principal on any path outside
  `exec/` and `exec-result/` with a 403.
- Revocation = delete that one identity record. Other machines and the browser are untouched.

Net: two DynamoDB fields, one line in the choke point, one guard before the object routes, plus a small
token-holder and an `enroll` verb in `tools/`. Per RULING 5 this is **option C**; options A and B are recorded
above with the reasons B was not taken and what retrofitting it would cost.

### 7.0.2 BLOCKER found at rung 0 (2026-08-08) — a machine cannot get a Cognito `sub` cheaply

§7.0.1 said "the loop signs in once as a distinct account" as though that were a small act. Reading the deployed
stack, it is not, and the reason is structural:

- `lib/p0-stack.js:183` attaches **one** `HttpJwtAuthorizer` bound to the Cognito user pool. `jwtClaims()` reads
  `event.requestContext.authorizer.jwt.claims` and nothing else. **Every route requires a Cognito JWT; there is
  no alternate auth path.**
- So a distinct machine principal requires a distinct **Cognito user**, and creating one is either self-signup
  (email + confirmation — not a one-command ceremony) or `admin-create-user` (needs AWS credentials on the build
  machine, which destroys the very blast-radius property EXC-C exists to create).
- Binding that user to the owner's `orchardUserId` is a second problem: `handleBind` derives a NEW
  `orchardUserId` from the presented public key when no record exists, so a machine would land in its own
  namespace unless the owner can vouch for it.

**The fork.** Three ways out, and they differ in kind, not just cost:

| | Mechanism | Ceremony | Attribution | Cost |
|---|---|---|---|---|
| **1** | machine self-signs-up a Cognito user | email + confirm, per machine | yes | medium, ugly UX |
| **2** | **dedicated `/exec/*` routes behind a second (Lambda) authorizer that verifies an enrolled ed25519 keypair** | owner issues a short-lived code; machine redeems it | yes | medium-large |
| **3** | same `sub` as the owner (the earlier option B) | none | **no** | small |

**Recommended: 2 — and it is stronger than the design it replaces.** The keypair machinery already exists and is
in use: `verifyEd25519`, `deriveOrchardUserId`, the challenge/bind flow, and `devicePublicKeys` (the record model
already carries MULTIPLE device keys under one `orchardUserId`, which is exactly the shape needed). Enrollment
becomes standard device pairing: the owner, signed in, issues a short-lived enrolment code; the machine generates
a keypair and redeems it; the record gains `kind:'machine'` + `label`.

The security win is the part worth noticing: with dedicated `/exec/*` routes behind their own authorizer, a
machine credential **cannot call `/objects` at all** — it holds no Cognito JWT, so the record routes are
unreachable by construction. That is strictly better than RULING 4's guard, which was a check someone could
forget to apply to a new route. **Scoping stops being a rule and becomes a property.**

**Consequence for the arc:** rung 0 grows (a Lambda authorizer + `/exec/*` routes + the enrolment code flow) and
`§3.0`'s "the client GETs `/objects/exec/<installId>`" changes to a dedicated `/exec/mailbox` route. The client
half is unaffected in shape — one deterministic fetch, one mailbox object.

### 7.1 The lease (this is the cross-machine half)

`RESEARCH_auto_glf.md` §9.2 already scoped it: the grader lease (`logs/run/grader.lease`) and the ack ledger
(`logs/run/builder-ack.jsonl`) are machine-local files, so a second machine's sessions would each hold "the"
lease and write duplicate results, failing silently. That port was parked on the trigger *"a second machine
actually joins."*

**An exec channel pulls the trigger.** Only one lane may drive a given install at a time, or two loops interleave
asks into one panel and corrupt each other's evidence — the same interleaving that produced findings 165125
locally. The exec lease therefore belongs in the **object store**, not the git bus: read-after-write is immediate
there, whereas a bus-synced lease inherits git latency (§9.2's own objection to porting it to the bus).

`exec-lease/<installId>` → `{holder: "<lane>", expiresAt}`. Claim-is-renewal, TTL = 3 missed ticks, same contract
as the grader lease. **A lane without the exec lease may not write an exec object.**

### 7.2 Consuming `[auto]`

Only after §7.1 holds. The tick reads a test's `[auto]` lines, writes one command, and reads the result on a
later tick. `[human]` lines are untouched — and stay untouched (§8).

### 7.3 Provenance in the trace

A remote-driven turn must be greppable as such. The router must not know the difference; a grader must. Proposal:
the dispatch logs `EXEC ▸ ask dispatched (remote, lane=<tag>, cmd=<id>)` immediately before the existing
`EXERCISE ▸ ask dispatched → conversation …` line, so the join is one grep.

---

## 8. What this does NOT solve

**Per-item correctness — CORRECTED 2026-08-08 (same day), and this is no longer a permanent limit.**

*What this section said, and why it was wrong:* the grader's blind spot was described as structural — BRANCH
redacts item text before egress (PP-5), so a trace could prove *13 items went into 3 arms with none left over*
and never *item X went into the right arm*. Four real misses were invisible to a grader that read the window as
clean-MECH/no-FAIL. The conclusion drawn — "`[human]` VALUE arms on classification features are human because of
a privacy property" — treated a shipping decision as a law.

*What changed:* `CHAT ▸ reply` (v2.74.2104, user-ruled full) puts reply prose on the fleet wire. A reply that
enumerates tasks and their dispositions is now readable by the grader, so per-item correctness is **not**
structurally human-only.

*The limit that actually remains* is narrower and is a property of the ANSWER, not the transport: a summary reply
("11 replacements") still cannot be graded per item; an enumerated one can. That is the answer-shaper's
granularity, and it is fixable — unlike a redaction boundary. **Do not cite this section as a reason a
classification test must stay `[human]`; check whether the reply enumerates first.**

*The meta-lesson, since this doc got it wrong twice in one day:* "cannot be observed" almost always means "was
never put in the field that ships". Read the serializer before designing around an observability limit — the
whole gap here was one field wide (`normalizeRingEntry` carries `msg`, drops `data`).

**The panel must be open.** `DEV_RUN_ASK` needs a panel to dispatch into and answers `panel-closed` otherwise.
This automates the *asking*, not the *being there*.

**The ask lands wherever the panel already is (REVIEW FIX, pass 1).** `DEV_RUN_ASK` dispatches into whatever
conversation is open; its own comment says *"choosing the conversation still belongs to whoever opens the
panel,"* because switching would mean driving the Rail's state machine. This is not academic — it is one of the
four causes of the 2026-08-02 INCONCLUSIVE run the exerciser was built for: *"an ask sent in a conversation that
lacked the connection (`PALETTE ▸ 118`)."* Remotely there is nobody to notice.

Mitigation, not a fix: the result records `conversationId` (§3.3), so **the loop MUST treat the conversation as
part of the precondition** — a test whose SCOPE requires a particular desk checks the returned id and grades
INCONCLUSIVE on a mismatch rather than reading the trace as a failure. Remote conversation targeting is parked
(§11); an ask delivered to the wrong desk is a confounder, and the loop already knows how to name confounders.

**Latency floor ≈ 60 s.** MV3 alarms do not go below a minute. Fine against a 5-minute tick; unusable for
interactive remote driving, which is not a goal.

---

## 9. Failure modes worth pre-registering

| Mode | Guard |
|---|---|
| Reload loop (result/seen written after reload) | §5 — mark seen + write result BEFORE invoking `reload` |
| Command re-fires forever | §4.4 single-use seen-set |
| Forgotten arm becomes a standing hole | §4.6 `ARM_TTL`, disarm on update |
| Two lanes drive one panel | §7.1 exec lease, cloud-side |
| Ask lands in the wrong profile | §3.1 explicit `installId` + client-side match |
| Grade attributed to the wrong build | §3.3 `version` stamped on the result |
| Remote turn indistinguishable in trace | §7.3 + `_DECISION_RE` (invariant #1) |
| Exec failure corrupts record sync | §2.1 — no `SyncKind`, separate alarm, separate storage |
| **Seen-set lost to SW death → reload loop** | §4.8 persist to `chrome.storage`, write before dispatch |
| **Clock skew expires everything / nothing** | §4.9 client clock decides; future-dated beyond `MAX_SKEW` refused |
| **`reload` disarms the channel it needs** | §4.12 arming survives reload, dies on version change |
| **Loop credential grants record access too** | §7.0 RULING 4 — path-scoped or not shipped |
| **Ask lands in the wrong conversation** | §8 — loop checks `conversationId`, grades INCONCLUSIVE on mismatch |
| **Disclosure asserts unenforced scoping** | §6.2 — EXC-2 gated on EXC-C |
| **Drivable before the lease exists** | §10 — EXC-3/4 refuse unless exactly one issuer is configured |

---

## 10. The ladder

**REVISED after review.** The first ladder was unbuildable from EXC-5 on (no machine credential, §7.0) and let
EXC-3/4 drive without a lease. Both fixed below; `EXC-C` is new and is the long pole.

**➜ The sequenced build order lives in `docs/BUILD_ARC_exec_channel.md`** — rungs, dependency logic, honest
sizing, per-rung verification, and the arc-owned rules (EXC-C is the stop condition; nothing ships in a release
without it; default-off is the rollback). This table is the ladder; that doc is the plan.

| id | slice | depends | size | gate |
|---|---|---|---|---|
| **EXC-0** | `Core/execCommand.js` — pure validate/authorize/decide + `Core/execCommand.test.js` (every refusal in §4, incl. skew, replay, expiry, target mismatch). Hoist `installId` out of `CloudLogShipper` (§3.1) | — | small | `npm test` |
| **EXC-C** | **Cloud: enrollment + a path-scoped machine principal** (§7.0.1, RULINGS 4 + 5, option C). `exercise.cjs enroll` → owner signs in → new `sub` bound to the same `orchardUserId` with `kind:'machine'` + `label`; one guard before the object routes. `orchard-cloud` work, deployed via that repo | — | small/medium *(revised down from "large" — §7.0.1)* | cloud tests + **a machine token proven unable to read `grounds`**, and two enrolled machines proven distinguishable in the audit |
| **EXC-1** | `settings:execChannel` + arming, `ARM_TTL`, kill-switch, boot re-read, reload-survives-arming (§4.12); dev-gated render | EXC-0 | small | `node --check`, live eyeball |
| **EXC-2** | The disclosure dialog (§6.2), acknowledgement required | EXC-1, **EXC-C** | small | live eyeball — copy must match what is enforced |
| **EXC-3** | Poller + dispatcher (`background/handlers/exec.js`) calling the existing handlers unchanged; the §5.1 ordering; `EXEC ▸`; `_DECISION_RE`. **Interim guard:** refuses unless exactly one issuer is configured, until EXC-5 | EXC-0..2 | medium | `node --check` + `npm run undef` |
| **EXC-4** | Results written back (§3.3), incl. the second write when the panel answers | EXC-3 | small | live |
| **EXC-5** | Exec lease in the object store (§7.1); drops EXC-3's interim guard | EXC-4, **EXC-C** | medium | `npm test` (pure election) + live |
| **EXC-6** | The loop consumes `[auto]` (`tick.cjs`) | EXC-5 | medium | §13 |

Order is deliberate: **the safety envelope is built and proven before anything can drive anything.** EXC-6 — the
only slice that delivers the original benefit — is last, so a half-built feature is inert rather than loose.

**EXC-C changes the shape of this project.** Before the review it read as a medium extension feature; it is
actually a small extension feature plus a cloud authorization change. If EXC-C is not worth doing, the honest
answer is to stop at EXC-4 with a single hard-coded issuer and one machine — which is *local* automation wearing
a cloud transport, and at that point `tools/exercise/exercise.cjs` plus an open CDP port is simpler and already
built. **The cross-machine claim is what EXC-C buys; without it there is no reason to prefer this design.**

---

## 11. Parked, with triggers

- **Verbs beyond `ask`/`reload`** — parked permanently absent a spec change (§4.2). Re-open only with a named
  test that cannot be expressed as an ask.
- **Interactive/low-latency driving** — parked on the MV3 alarm floor. Would need a push transport; no use case.
- **Cross-identity driving** (someone else's install) — **out of scope, not parked.** Commands are scoped to the
  issuer's own bound identity. Widening this is a different product with a different threat model.
- **Retiring `tools/exercise/exercise.cjs`** — keep it. It needs no cloud, no arming, and no network, and it is
  the right tool when you are sitting at the machine. The two coexist; the CDP port stays a per-session decision.

---

## 12. Open for the user

1. **`ARM_TTL` = 8 h** — long enough for a working day, short enough that a forgotten arm dies overnight. Confirm
   or set a number.
2. **Where does arming live** — a dev-mode sub-toggle (armed separately, after dev is on), or does enabling dev
   arm it? The spec assumes **separate**: dev mode has many other uses, and coupling them makes the disclosure
   a lie for anyone who wanted the dev panel and not a remote hand.
3. **Disclosure copy** (§6.2) is a first draft. It is user-facing text making a security claim; it should be
   yours before it ships.
4. ~~**Is EXC-C worth it?**~~ **RULED 2026-08-08 — yes, option C** (§7.0.1, RULING 5). Enrollment: the owner's
   login mints a distinct, labelled, revocable machine principal. Owner-only creation is preserved; attribution,
   revocation granularity and path scoping are kept.
5. **`MAX_SKEW` = 5 min** and **`MAILBOX_MAX` = 5** — confirm or set.
6. **Enrollment UX** — does `enroll` open a browser window on the build machine (auth-code flow, needs a display),
   or should it print a device code so a headless box can be enrolled from a phone? Only matters when the first
   machine without a display is enrolled; the ceremony is otherwise identical.

---

## 13. How the channel itself gets graded

*(Added by review, pass 2. A feature built to serve the verification loop must be verifiable BY it, or it is the
thing it was built to prevent.)*

The bootstrapping trap: a remote-driven ask that silently fails to dispatch looks **identical** to a loop that
never fired. Both produce an untouched panel and a quiet trace. Left unaddressed, EXC-6 could report progress it
is not making — the exact "MECH alone is not a grade" failure the loop prompt cites, applied to the loop.

The result object (§3.3) is the anti-paradox mechanism, and it is why EXC-4 precedes EXC-5. The channel's own
bus test therefore reads:

```
SCOPE        = an armed instance with a mailbox written this window · grep: `EXEC ▸`
QUANTIFIER   = ONE delivered command suffices
MECH         = grep: `EXEC ▸ ask dispatched (remote,`   — the dispatcher RAN
VALUE        = an `exec-result/` object with outcome=dispatched AND a matching
               `ROUTE ▸`/`INTERPRET_RAW ▸` turn in the SAME window   — the ask actually became a turn
FAIL         = `EXEC ▸ dispatched` with NO turn in the window        — it claimed to drive and did not
INCONCLUSIVE = panel-closed · disarmed · expired · conversationId ≠ the test's desk (§8)
```

`MECH` here is the dispatcher logging; `VALUE` is a real turn appearing. The distinction matters because the
first draft's only evidence would have been the dispatcher's own claim — a success tally, which this project has
already learned is not a correctness signal.
