# DESIGN — Ground Vitals (VT): proactive belief maintenance + the Connect tab

**Status: spec v1.1 (2026-07-17); VT-0..VT-4 BUILT same day (v2.74.1569-1572 — the transport-general funnel
`reportLegOutcome` + `Core/vitals.js`, the `vitals:tick` scheduler absorbing `conn:heartbeat`, the Admin desk
with incident cards + the moved vitals card + chips, the daily ephemeral visit with canary + confirm re-probe,
the signed-out→fresh catch-up). Live verification owed (§10 notes). v1-impl deviations: the visit runs the
CANARY DIRECTLY (the executor's own belts + the registry gate stand in for the separate probe-first request —
one request serves both beliefs; upgradeable later); incidents render as CARDS in the Admin desk thread
(per-incident CASE conversations = VT-2b, deferred); the routine pre-flight (§4) is deferred with the catch-up
trigger built (needs the desk→origin binding exposed SW-side). VT-5 gated on SH-T4; VT-6/7 pending.**
TRANSPORT-GENERAL: the belief kinds cover all three leg
transports (session-ride · drive · broker); v1 builds the ride bindings, VT-6/7 bind the others (§2b).
Companions: `DESIGN_route_heal.md` (RH — the drift class),
`DESIGN_connectors.md` (§14 identity verdicts, §16 ephemeral managed tabs, §18 observability),
`DESIGN_desks.md` (the desk unit), `DESIGN_conversation_focus.md` (cases born holding a record — the incident
model), `Core/connectionPresence.js` + `background/handlers/connections.js` (CP — the presence class).
**Supersedes** the CP-3 ownership-redesign direction ("make the Front desk the single presence authority"):
authority moves to the Admin desk instead; the "desks at most a pointer" half survives unchanged.

## 1. The problem

Three detect→heal loops exist, built independently, sharing one event stream without knowing it:

- **Presence (CP)** — "is this origin's session live?" Reactive (`reportAuthSignal` on every ride outcome) +
  half-proactive (`conn:heartbeat`, a 20-min alarm that probes **open-tab origins only** — a closed app gets
  zero attention until something fails).
- **Route-drift (RH)** — "is this recipe's shape current?" Reactive only: the user eats ×2 failures before
  `driftSuspect` even stages.
- **Op-bank (unnamed)** — "is this persisted-op sha current?" Reactive-inline: HASH_STALE 404 → clear + a
  "do one by hand" hint that predates (and is) the RH relearn sentence.

At the executor they already run side-by-side on the same event (`rideOutcomeSignal` + `reportAuthSignal` +
`_healTick` at SESSION_REPLAY's http-error exit) — two classifiers, one event, three stores, and a surface
story that reports session expiry in the Front desk AND every other desk (the CP-3 duplication).

**Grouping boundary (v1.1 refinement):** the subsystem is defined over LEG TRANSPORTS — session-ride, drive,
broker — not over rides alone. What vitals OWNS is detect scheduling + evidence pooling (the funnel) + the
surface; **heal machinery stays owned by each substrate** (landmark probe-or-recover, walk re-teach, the RH
relearn flow, the broker re-link dance) — vitals schedules detection and surfaces incidents that deep-link
into the existing heals, never re-implements them. Still no generic "belief framework": the belief KINDS are
fixed (can-act · shape-current · artifact-freshness) and each transport supplies concrete bindings (§2b);
adding a transport = adding classifier entries + scheduler rows, never touching the spine.

## 2. The model — ordered beliefs, two ways of knowing

Each class is: a belief → evidence (FREE from ride outcomes; PURCHASED by the scheduler) → a classifier → a
state machine with hysteresis → a heal → a verify. The classes are **ordered priors**: session → shape → sha.
A downstream belief is only evaluable when its prior holds.

| | Presence | Route-drift | Op-bank (writes) |
|---|---|---|---|
| Key | origin | recipe | (origin, opName) |
| Prior | — | presence fresh | presence fresh |
| Detect | probe (designed-for; safe signed-out — that IS its verdict) | canary READ (`auto`-class) | **inference only** — deploy fingerprint + the reactive 404 |
| On prior failure | its own verdict | deferred (named reason) | deferred |
| Failure verdict | signed-out | `driftSuspect` (×2) | stale-**gradient**, never auto-clear |
| Heal | HUMAN signs in (§16 — auth is never created) | demonstrate once → HITL diff (RH-1b/1c) | PASSIVE re-bank from own-traffic captures |
| Verify | next probe/ride → fresh | next invoke → `HEAL ▸ cleared` | next confirmed write rides the fresh sha |

**Probe-able vs inference-only** is the safety model showing through the architecture: a presence probe is
free by design; a drift canary costs one unattended-safe read; a WRITE op cannot be probed AT ALL — there is
no half-send of a mutation, and a junk-variables "probe" is firing a write unattended (breaking both belts).
What you're allowed to ask the world determines how you're allowed to learn about it.

### 2b. Transport bindings — the same belief kinds, different detect physics

| Belief kind | Session-ride (v1, above) | Drive (VT-6) | Broker (VT-7) |
|---|---|---|---|
| Can-act | origin session (probe / ride outcomes) | **the SAME origin-session belief** — one presence row serves both transports — plus page-reachable | OAuth LINK status (`GET_CONNECTOR_STATUS` / invoke outcomes: `connector-not-linked`); heal = the re-link dance (HITL, like sign-in) |
| Shape-current | endpoint/headers → canary read | landmark/selector validity → **probe sweep on the daily visit** (pure DOM reads — the visit is already on the page; near-free) | tool schemas → **`tools/list` DIFF vs the `liveTools` cache** — the provider PUBLISHES its current truth; detect is metadata comparison, no probe at all |
| Artifact-freshness | persisted-op shas (fingerprint) | — (walk start-URLs self-stamp on success, v1556; no scheduled check) | — |
| Heal ownership | RH relearn (HITL) | probe-or-recover (auto) / re-teach (HITL) — EXISTING, untouched | cache refresh (auto) / re-link (HITL); a DISAPPEARED tool the user's aliases rely on → incident |

Transport-specific detect limits, stated once:
- **Walk EXECUTION is never canaried** — replaying a walk drives the UI (clicks/typing, visible tab motion,
  possible side effects). Walk health is INFERRED from its landmarks' probe results + reactive replay
  outcomes; the re-teach stays reactive/HITL.
- **Broker tools are never executed as canaries** — a tool may be a WRITE and may bill; broker detect is
  metadata-only (status + tools/list). The third instance of the probe/inference law.
- The ordering rule (§3) generalizes verbatim: landmark probes are presence-gated (a login page's DOM would
  read as universal selector rot — the drive twin of the 404-on-anon bug); broker checks carry their own
  prior (link status gates schema expectations).

**The presence verdict is defined as RIDE-ABILITY**, not the user's abstract auth state: if an ephemeral tab
can't reach an authenticated session, rides couldn't either (a cold start hits the same wall) — so
"signed-out (for rides)" is honest even when the user considers themselves logged in elsewhere.

## 3. Ordering rules (and the latent bug they fix)

1. **Presence gates everything downstream, on BOTH paths.** Proactive: the canary/fingerprint runs only after
   the same visit's probe says fresh. Reactive: the outcome funnel (§4, VT-0) classifies presence FIRST and
   refuses drift evidence while the origin's registry verdict is signed-out — this fixes a live latent bug:
   apps that answer anonymous requests with 404-empty currently tick `missStreak` while the user is merely
   logged out (false drift).
2. **Deferral is stateful, catch-up is event-driven.** A skipped check records `deferred(signed-out)` — no
   tick, no `lastSweepAt` stamp (no silent starvation). The catch-up trigger is the signed-out→fresh
   TRANSITION (already observable in `reportAuthSignal`), not the next day's alarm: sign in → overdue checks
   for that origin fire within minutes.
3. **`op-hash-stale` never counts as route drift** (already enforced: the rewrite precedes the tick) and a
   drift 404 never counts as an auth signal (`rideOutcomeSignal` excludes it). The classifiers partition one
   failure space; that partition is the subsystem's contract.

## 4. The spine — one funnel, one scheduler, one daily visit

**VT-0 — the outcome funnel.** Fold the side-by-side executor calls into ONE `reportLegOutcome(evt)` that
runs presence → shape → freshness classification in order. **Transport-general from day one**: `evt` carries
`{transport: 'ride'|'drive'|'broker', ...}` even while only the ride classifiers exist — INVOKE_SESSION /
SESSION_REPLAY report `ride`; REPLAY_SG_CAPABILITY and walk verdicts later report `drive`; INVOKE_CONNECTOR
reports `broker` (its `connector-not-linked` / tool-not-found failures are link-presence / schema-drift
evidence respectively). One call per executor (a new emitter can't half-wire it — the invariant-#2 lesson
applied to classifiers).

**VT-1 — the scheduler.** `chrome.alarms` (persist across SW restarts natively — the house idiom). The
critical semantic: **the freshness WINDOW is the cadence; the tick is just the scanner.** Every class check is
staleness-gated on persisted `last evidence at` (organic evidence counts — an actively-used app is never
probed), so the dozens of daily SW restarts and alarm catch-ups can never double-run, and "on launch" means
"an immediate tick; the windows decide what's overdue." `conn:heartbeat` folds in as `vitals:presence`
(one clock owner).

**VT-3 — the daily ephemeral visit.** For each ride-armed ground (`_rideArmedGrounds` already indexes them)
without fresh-enough evidence: one §16 ephemeral background tab — probe presence → if fresh, run the canary
read → glance the deploy fingerprint → (VT-6) sweep the ground's promoted landmarks (querySelector + identity
checks — pure DOM reads, the drive-class check riding the same page for free) → close on idle. One visit
serves every belief class the ground has. **The visit never clicks, types, or navigates within the app** —
DOM reads and fetches only. Broker checks need no visit at all (cloud-side status + tools/list). Reach limit, stated
honestly: the ephemeral tab inherits the COOKIE jar, so this tier serves cookie-auth apps; an in-memory-token
app boots anonymous unless its IdP silent-auths on load (Deako does) — the visit try-and-classifies, and a
no-silent-auth app honestly reports "signed-out (for rides)" when closed. **Confirm re-probe:** a first canary
miss schedules ONE one-shot alarm +30–60 min — the ×2 threshold crosses same-day and the proposal stages with
zero user pain. **Pre-flight rule:** a scheduled routine's first run of the day presence-checks its origin
first (one probe, seconds before the work) — the sharpest closed-tab staleness case, covered event-driven.

## 5. Cadences

| Class | Freshness window | Tick | Governing factor |
|---|---|---|---|
| Presence, open-tab | 30–60 min | 20 min (existing) | user-pain avoidance; organic evidence suppresses most probes |
| Presence, closed-tab | ~24 h | daily visit | surprise cost of ephemeral tabs, not load |
| Drift canary | ~24 h (+30–60 min confirm) | daily visit | HITL heal latency + deploy-scale decay — sub-daily buys nothing |
| Op-bank | none | piggybacks visit + event-driven | inference-only; captures re-bank whenever they happen |
| Drive landmark sweep (VT-6) | ~24 h | piggybacks the visit | free once the tab is open; DOM reads only |
| Broker link status (VT-7) | ~24 h | own alarm, cloud-side | cheap status call; no tab; invoke outcomes suppress |
| Broker schema diff (VT-7) | ~24 h–weekly | rides the status call | tools/list is one request; drift is provider-published |

Budget sanity: 5 apps ≈ a handful of idle-gap probes + 3 ephemeral visits/day + 1–2 cloud status calls —
under one case fan-out's minute of traffic. Windows are settings; the ephemeral tier gets the one prominent
toggle.

## 6. Canary discipline (hard lines)

- Params-free, `auto`-class, PROVEN (curated or `lastOkAt`) reads only — prefer `pulse`-marked legs
  (`vs_warranty_stats`, `shopify_orders_queue`). **Never** replay stored user params on a schedule.
- Writes never. The tee is NEVER armed by vitals (capture stays consent-gated + user-initiated in relearn).
- The canary runs through the NORMAL executor — `_healTick`/the funnel do the rest; the sweep is just a
  caller. The result value is DISCARDED (the sweep wants ok/status/jsonBody, never data).
- Honest limit: canaries catch deploy-class drift (the Shopify kind — a shape family breaking at once).
  Endpoint-class drift on parameterized reads stays reactive-only; there is nothing safe to probe it with.
- A future persisted-GET read leg can double as the canary (one request tests shape AND sha).

## 7. The op-bank class (VT-6 — after SH-T4)

- **Detect by inference:** stamp the admin's build fingerprint (main bundle asset hash) at bank time; the
  daily visit reads the current one. Changed → the banked write-ops age. **Gradient, not binary** (Shopify
  front-end deploys daily; a binary suspect would train the user to ignore it): the card shows "banked N days
  ago, M deploys since". Hard verdicts stay: reactive 404 proves stale (clears, as today); a fresh capture
  proves current.
- **Heal is passive:** any organic capture of the app's own traffic yielding an (opName, sha) pair for a
  banked op re-banks it silently (`HEAL ▸ re-banked`). Mechanical, no HITL — the op NAME is the semantic
  identity, the sha is transport, and every execution still passes both write belts + preview.
- **Injection hard line:** (opName, sha) pairs are accepted ONLY from captures of the app's own requests —
  never from page content, never from model output. The sha channel must not become a write-path injection
  surface.

## 8. The surface — the Connect tab

**Supersede (Connect, 2026-08): the operator surface is a RAIL TAB, not a desk.** The original §8 "Admin desk"
was a category error — system STATE wearing a conversation costume so it could live in the Conversations tab
(its own seed had to open with *"you are NOT a website desk"*). It graduates to the third Rail tab, completing
the trifecta:

| Tab | Concern | Unit |
|---|---|---|
| **Chat** (was "Conversations") | the views you work in | desks / presets |
| **Automate** (was "Automations") | what runs unattended | scheduled + parked runs |
| **Connect** (new) | the connections both ride on | status cards |

Chat and Automate are the two ways you USE Orchard; both ride on your connections, so Connect is the substrate
under the other two — not a tacked-on "errors" tab.

### 8.1 One incident model, two renderers — the design law

**DESIGN LAW — dev-maximalist / user-subset:** a feature is specced MAXIMALLY for the developer/debug mode,
then a deliberate, smaller USER-FACING subset is exposed in V1. Vitals is the archetype: the whole VT arc
(presence, drift, reachability, request-shape, op-bank, broker) is **Orchard's instrument panel**, not user
product — the Admin desk's mistake was showing the whole panel to everyone. Connect stays ONE incident model
(the §4 funnel + the §8.3 store, untouched) with a `_devModeEnabled` fork in the RENDERER — never two health
systems.

- **User render (V1)** — the user is responsible for exactly ONE thing: keeping connections signed in. Connect
  shows a card ONLY when the user must act, and the only act is sign-in (or "contact your admin"). Drift,
  reachability, request-shape, the vitals bars — all invisible; Orchard auto-heals and shows its work only in
  dev.
- **Dev render (later)** — the maximalist console of §8.3 (vitals bars, drift/HEAL + relearn diffs,
  reachability, reasoning-service, never-checked, the operator NL asks) renders in the SAME tab.

### 8.2 The Connect tab — minimal V1 (the user render)

**Two states.** Healthy → one quiet line, "All connections active" (no bars, no "all checks passed" digest —
that trains ignoring). Attention → one status card per affected connection.

**The status card — two variants, nothing more:**
1. **Signed out** — `{App} — signed out` · **[Sign in]** (opens the site to authenticate).
2. **Needs reconnecting** — `{App} needs reconnecting — contact your system administrator.` No self-serve
   action (a V1 user can't relearn); this is the fold-in for an un-auto-healable drift / unreachable.

Fields: app name · one-line state · optional "since" · the action. NO bars, diffs, or canary detail — dev only.

**Lifecycle (honest, still simple).**
- **Opens** when the funnel (`reportLegOutcome`) logs an `auth` failure → signed-out; or a `miss`/drift Orchard
  could NOT auto-heal → needs-reconnecting.
- **Verifying** — after sign-in, a brief `Checking {App}…` while the canary (the outcome test) runs.
- **Clears** on the OUTCOME TEST passing (CS-1, `connection_scope_desk_preset.md`), never the raw sign-in EVENT
  (the false-clear CS-1 exists to prevent); on failure it stays — `Still can't reach {App}`.
- **One card per connection** (desk+preset scope, CS-1) — never per conversation or per leg.

**Badge.** Connect badges with the count of connections needing attention; quiet otherwise. It absorbs the
`btn-rail` needs-action dot FOR CONNECTION ISSUES only — Automate keeps its own for parked runs (two
independent attention sources, not one global dot).

**Desks (in Chat).** Unchanged from the §8.3 chip rule — a desk chips when ITS connection is down; the chip now
opens Connect (was: the Admin desk).

**Migration.** The Admin desk (`ADMIN_ID` + its seed variants) retires as a USER surface; incident cases
(`vtc_`) migrate to the Connect card store; the Connections card + "show dashboard" / operator richness move to
the dev render. The §4 vitals engine (funnel, `vitals:tick`, canary, incident store, CS-1 outcome-to-close) is
UNCHANGED — only the presentation moves.

### 8.3 The dev render (the maximalist console — retained from the original §8)

*Below is the original §8, now scoped to the DEV-mode Connect view (not a user desk). Throughout 8.3, "the
Admin desk" = the dev-mode Connect view, and "Front chip → Admin desk" now reads "→ Connect".* A **permanent
operator surface**; role = Orchard-operator, queue = incidents, scope = all grounds. The case model fits
because **an incident IS a case** (the FC machinery, reused whole):

| Vitals event | Desk machinery |
|---|---|
| a belief flips (signed-out ×N, driftSuspect, op-stale) | a case is BORN holding the structured record ({class, subject, verdict, evidence, since}) as its pinned focus entry |
| the heal | happens in the case's thread — the EXISTING bars (sign-in, relearn, diff card) |
| repeat/flapping evidence | appends to the ONE open case per (class, subject) — subject is an origin, recipe, landmark set, provider, or tool as the class dictates; the thread is the incident timeline |
| verification | auto-closes the case, one quiet closing line |
| the Rail | incident history for free (delivers RH spec §6's drift telemetry, human-readable) |
| the vitals scheduler | is this desk's routine |

Rules:
- **Authority MOVES, never copies.** The Connections card relocates here and becomes the vitals card
  (presence · shape · op-bank rows per ground). The Front desk keeps ONE chip ("N need attention → Admin
  desk"); per-desk warnings become pointer chips scoped to that desk's own dependencies. Re-creating the
  CP-3 duplication one level up is the failure mode this section exists to prevent.
- **Point-of-need bars stay.** The relearn/sign-in bars under a live failure are interrupts, not reports;
  they and the desk write the same state, so the surfaces cannot disagree. Ambient (canary-detected)
  proposals — which have no failed ask to hang a bar on — land here as incident cases.
- **Studio stays the workbench.** The desk renders incident cards + the existing action bars and DEEP-LINKS
  into Studio/ground-panel for surgery. Never re-render Studio's review UI in chat (no third copy).
- **Silence when green.** No cases → no lines, no "all checks passed" digest (that trains ignoring). Badge
  count on the Rail entry when open cases exist. The Admin desk should be the quietest desk in the Rail —
  its value is that when it speaks, it's real.
- v1 scope: vitals incidents + the moved card + chips. Natural accretions (NOT launch): pending harvest
  reviews ("banked 9 reads — accept the GETs?"), duplicate-ground merge proposals, sync status.
- Naming: RESOLVED (Connect supersede) — the surface is the **Connect** tab (Chat · Automate · Connect);
  "Admin desk" survives only as this dev render's internal name.

### 8.4 Function inventory — what the retired Admin desk did (the dev-render rebuild checklist)

Captured at removal (**CN-2**) so the §8.3 dev render can be rebuilt with **nothing lost**. Every function's DATA
comes from the UNCHANGED vitals handlers (`background/handlers/vitals.js` + `connections.js`); only the Admin-desk
PRESENTATION was retired. The former chat.js sites are named so the rebuild has anchors.

- **F1 — the Vitals card** (`_maybeRenderAdminDesk`, driven by `VITALS_STATUS` → `{registry, grounds, incidents, now}`):
  - *Presence rows* — `renderConnectionsCard(registry)`: which apps are signed in (per-origin presence · shape · op-bank).
  - *Ride-shape rollup* — per ground `{host, armed, lastOkAt, driftSuspects, proposals}` → "• host — N reads, last ok Xh ago · ⚠ drift / shape ok".
  - *Open-incident pointer* — "⚠ N open incidents — see the cases" (silence when zero).
  - *Recently auto-resolved* — `recentlyResolved(incidents, {cls:'presence'})`: the presence audit trail (subject · how · when).
  - *Cloud-logs line* — a standing "cloud logs: on (level)" while shipping is enabled.
  - *Actions* — **Sign in {origin}** (×≤4, `CONN_FOCUS {origin}`) · **Check now** (`VITALS_CHECK_NOW`, manual canary) · **Keep-alive…** (`_showKeepAlive`, the per-connection opt-in picker).
- **F2 — incident cases** (`_syncIncidentCases` → `vtc_<id>` sub-conversations, one per OPEN incident): the incident timeline; heal bars reused verbatim (sign-in for presence, the RH-1b relearn/diff bar for drift); auto-close on verification with one quiet closing line; the "+" mints a by-hand Ops case.
- **F3 — the connections chip** (`_maybeRenderConnCard`, Front/Overview): the one-line "N need attention" signal (`VITALS_BADGE`) pointing at the console. *(CN-2: re-pointed to the Connect tab; CN-1 also badges the Connect tab itself.)*
- **F4 — the context dashboard** (`VITALS_DASHBOARD` via "show dashboard" on the desk): the full vitals dashboard CanvasSpec (`Core/vitalsDashboard.js`).
- **F5 — the operator persona** (`_ADMIN_SEED`): NL "what's signed in / relearn X / what's down" answered in the operator role. *(CN-2: retired for users; the Connect card ACTIONS replace the conversational asks — §8.2.)*

**User subset (§8.2, shipped CN-1):** F1's presence/sign-in + F3's attention count only. Everything else — ride-shape,
drift, Check-now, Keep-alive, the F2 cases, F4 dashboard, F5 persona — is **dev-only**, the §8.3 render behind
`_devModeEnabled`. **CN-2 retires the Admin desk as a user surface** (dev-gated + user pointers re-pointed to Connect);
the full code delete lands when the §8.3 dev render absorbs F1–F5 into the Connect tab.

## 9. Hard lines (consolidated)

Reads only, ever; params-free canaries; no stored-param replay; no tee arming; writes never probed; sha pairs
from own-traffic captures only; §16 — auth is never created, the presence heal is always the human; presence
gates downstream evidence on both paths; suspect states never auto-clear without a verify; logs body-blind
(`VITALS ▸` carries ground/class/verdict/counts — never data); silence when green. Transport additions: the
ephemeral visit NEVER clicks/types/navigates within the app (DOM reads + fetches only — walk execution is
never scheduled); broker tools are NEVER executed as canaries (a tool may write and may bill — broker detect
is metadata-only); heal machinery stays owned by its substrate — vitals schedules and surfaces, never
re-implements a heal.

## 10. Build ladder

**Connect supersede (2026-08):** the SURFACE work is re-homed and re-ordered — ship the **user render first**.
**CN-1** — the Connect Rail tab (Chat · Automate · Connect) + the two V1 status-card variants (§8.2): the
funnel's `auth` / un-auto-healable `miss` outcomes as the ONLY user-visible cards, the sign-in / contact-admin
actions, the outcome-test clear (CS-1), the tab badge, and the desk-chip re-point to Connect. The original
**VT-2 "Admin desk"** below becomes the **dev render** (§8.3), gated behind `_devModeEnabled`; VT-3..7 accrue
into it. Engine layers (VT-0/VT-1) are unchanged and precede both.

- **VT-0** — the outcome funnel: `reportRideOutcome(evt)` folds `reportAuthSignal` + `rideOutcomeSignal` +
  `_healTick`; presence-gates-drift ordering (fixes the 404-on-anon false-drift bug). Pure ordering + tests.
- **VT-1** — the scheduler spine: freshness windows + persisted evidence stamps + launch-if-due tick;
  `conn:heartbeat` folds into `vitals:presence`. (+ `VITALS ▸` into BOTH decision REs — invariant #1.)
- **VT-2** — the Admin desk v1: desk type, incidents-as-cases from REACTIVE flips, the vitals card moves in,
  Front chip + per-desk pointer chips, silence-when-green. (Surface first — reactive incidents give it
  immediate value, and VT-3's ambient proposals need a home to land in.)
- **VT-3** — the daily ephemeral visit: closed-tab presence + drift canary + confirm re-probe; canary
  selection rule; the ephemeral-tier setting.
- **VT-4** — event triggers: signed-out→fresh catch-up; the routine pre-flight rule.
- **VT-5** — the op-bank class: fingerprint stamp at bank + visit glance + gradient display + passive
  re-bank. **Gated on SH-T4** (can't keep fresh what you can't bank) — by dependency, not by value.
- **VT-6** — the DRIVE bindings: the landmark probe sweep joins the daily visit (presence-gated, DOM reads
  only); drive replay/walk outcomes join the funnel as `transport:'drive'` evidence; walk health rolls up
  from its landmarks + reactive verdicts; incidents deep-link to the EXISTING probe-or-recover / re-teach
  flows. The vitals card's drive row upgrades from display-only to scheduled.
- **VT-7** — the BROKER bindings: link-status class (status call on its own alarm; `connector-not-linked`
  invoke outcomes as free evidence; heal = the re-link dance) + schema-currency class (tools/list diff vs
  the `liveTools` cache; auto-refresh on compatible change; a DISAPPEARED/renamed tool that stored aliases
  reference → incident). No visit needed; metadata-only by hard line.

## 11. Open questions

- Incident-case persistence: keep closed incidents forever (recommended — free outage/drift history in the
  Rail) or prune on a horizon?
- Ephemeral-tier default: ON with a first-run notice line in the vitals card (recommended — canaries are the
  unattended-safe class and fan-outs already run unasked reads), or OFF until enabled? The toggle exists
  either way.
- Fingerprint source hardening: the main bundle hash is one signal — is an app's build id exposed anywhere
  more stable (a meta tag, a version endpoint already captured by harvest)?
- ~~Display-only DOM-plane rows~~ RESOLVED by v1.1: drives are a first-class transport binding (VT-6) —
  scheduled landmark probes, not just display; walk EXECUTION stays out of the scheduler permanently.
- Broker schema-diff semantics: which diffs auto-refresh silently (additive/compatible) vs raise an incident
  (a tool stored aliases reference disappeared or changed required params)? Needs the alias store consulted
  at diff time.
- Broker link-expiry lead time: the proxy may know token expiry — can the status call surface "expires in
  N days" so the re-link incident opens BEFORE the first failed invoke?
