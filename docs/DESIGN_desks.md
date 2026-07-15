# DESIGN — Desks: the role-scoped unit (the apps-structure spec)

**Thesis.** The top-level unit a user opens, names, and pins is a **role-scoped Desk**: a *goal* + a *set of connected grounds* + *memory* + *the loop* + a *presentation plane*. New sites (VendorSuite warranty, Aircall calls) do **not** earn new unit *types* — they are **object-model bindings (presets)** of the queue-shaped type that already exists, and the next increment is **federating** a Desk's queues across its connections rather than forking a manager per site.

**Status.** Framing + direction. The TYPE→PRESET→INSTANCE stack, per-instance connections, object-model reasoning, the generic queue console, two-tier memory, the two site PRESETS (DK-1 ✓), and the **presence capability class** (DK-2 ✓ — presence excluded from the queue sweep) are **built**; the WorkItem normalizer (DK-3 ✓) and the federated cross-site sweep + `corrKeys` issue-grouping (DK-4 ✓) are **built** too, and the **user-facing UI adopted "Desk"** (v2.74.1485). A multi-connection desk is **assemblable today** — the AS-4 setup wizard accretes a *set* of sites — so DK-4 federation is **live-testable now**; the issue-steered proposals are just not yet eyeballed. **DK-5** (cross-site proposals) and the presence **status UI surface** remain **owed**.

**Neighbors.** `DESIGN_conversations.md` (§13 catalog, panes), `DESIGN_apps_learning.md` (§10–11 two-tier memory), `DESIGN_app_fleet.md` (the queue console), `DESIGN_connectors.md` (legs: ride/drive/broker), `DESIGN_canvas.md` (presentation), `DESIGN_llm_front_door.md` (routing). Catalog: `Core/appCatalog.js`.

---

## §1 — The axis this settles: role, not site

Two ways to slice the unit:

- **By site (vertical):** *Warranty Manager*, *Call Manager*, *Ticket Manager* — each single-site, each re-implements the same loop (enumerate a queue → reason per item toward the goal → propose → HITL → act → learn), none can see across sites.
- **By role (horizontal):** one **operator Desk**, multi-site connected, one loop, an object model **per site**, correlating items across sites.

Everything is built horizontal, and the vertical slice would *un-generalize* working code:
- `Core/appCatalog.js` already separates **TYPE** (loop shape) from **PRESET** (bound object model) from **INSTANCE** (configured + connected + remembering).
- `connections` (AS-4) is already a **set** — one instance operates over many grounds.
- The queue console (`fleetOfferedLegs` → `REVIEW_QUEUE` / `SHOW_ITEM_SOURCES`) is already parameterized by `objectModel.plural`, not hardcoded to a site.
- `summarizeItem` (`Core/connectorRender.js`) already normalizes any site's rows to `{title, status, id, url}`.

Per-site managers throw all of that away.

## §2 — Naming

- **Unit = Desk** (support desk, help desk, trading desk): a place you sit with your **queue and tools around you**, carrying standing context. Accurate to what an instance is — a *multi-site* operator workspace (the AS-4 wizard binds a SET of sites); "app" reads as a bundled program, which it is not. (**Adopted in the UI at v2.74.1485**: the gallery, rail row, setup prompt, and `save as desk:` / `forget desk:` commands say "Desk" — `app` kept as a command alias for back-compat. Internal `app*` identifiers, CSS classes, and storage keys stay `app`: renaming them is churn with no user value.)
- **Loop-kind is already named — `archetype`:** `operator` | `monitor` | `executor` (Inbox / Watcher / Concierge). Use these; there is no naming gap here.
- **NOT "agent" for the unit.** Disqualifying collision: "agent" is the *domain's* word for the human operator — `aw_my_agent`, `getAgentV2.ID`, Zendesk agent-workspace. "The agent's agent" is confusing in logs, UI, and speech, and overclaims autonomy versus the HITL-at-promotion-and-action reality. Reserve "agent" for prose about the reasoning loop, never the unit.
- **Spawned children = CASES (v2.74.1492).** The per-item unit a desk opens (a routine's fan-out, "for each new task in Greensboro, open a case…") is a **Case**: opened *on* an item/issue, worked (research → propose → HITL), closed when the item resolves. Not a desk (shares the parent's memory/connections/config; a leaf; many + disposable vs few + pinned) and never "agent" (the children are the *most* supervised unit — and the §2 collision again). Domain-native — the Warranty seed already says linked items "are ONE case", which is the DK-4 convergence: a case is opened on an *issue* (v1 = one item; federated = the cross-site set). Taxonomy: **Desk** (role-workspace, durable) → **Case** (work unit, open→worked→closed); **Routines** open cases. Cases are auto-named by their ITEM (planSubTasks titles by label), badge "case" in the Rail; internal `subTask*`/`role:'subtask'` identifiers unchanged.

## §3 — The stack that already exists

```
TYPE        Inbox            Watcher          Concierge          ← archetype + a TEMPLATE object model
  │         (operator)       (monitor)        (executor)
  ▼
PRESET      Support agent    Financial monitor  …               ← a TYPE + a BOUND object model + role/safety prose + baseline deltas
  │         (Inbox⋅tickets)
  ▼
INSTANCE    "my Deako desk"                                     ← a PRESET + connections + per-instance memory (pinned, durable)
```

- **TYPE** — the loop shape, defined by an object model *orthogonal to* the archetype. **Inbox = the queue manager**: a queue of stateful objects, view · act · transition.
- **PRESET** — binds the type's object model to a concrete noun/states and adds role prose + a hand-authored `baseline` (generalizable rules, never facts).
- **INSTANCE** — a live, connected, memory-carrying Desk. Per-instance identity (AP-0); the preset seeds it, only canonical deltas rise back (§10 two-tier).

## §4 — Warranty Manager & Call Manager are Inbox PRESETS, not types

The queue manager the question reaches for **is the Inbox type**. So both new "managers" are the *same relationship Support agent already has to Inbox* — a bound object model + prose, connected to their site:

```js
// Warranty Manager  (Inbox preset, connected to vendorsuite.drhorton.com)
objectModel: { noun: 'warranty task', plural: 'warranty tasks',
  states: ['new', 'open', 'fixed', 'closed'],
  actions: ['read', 'research', 'schedule'],
  transitions: [{ verb: 'fix', to: 'fixed' }, { verb: 'close', to: 'closed' }] }

// Call Manager  (Inbox preset, connected to workspace.aircall.io)  — see §5 wrinkle
objectModel: { noun: 'conversation', plural: 'conversations',
  states: ['opened', 'closed'],
  actions: ['read', 'call-back', 'wrap-up'],
  transitions: [{ verb: 'close', to: 'closed' }] }
```

Warranty tasks {new/open/fixed/closed}, tickets {open/pending/solved/closed}, missed-calls/open-conversations {opened/closed} are **the same shape**: a queue of stateful work-items. Do **not** add sibling types. When a user's role is genuinely narrow (a warranty-only back-office clerk), that's a Desk **instance scoped + named** to warranty, not a new type — same engine, configured narrow.

## §5 — The one wrinkle: presence is not queue-work

Aircall's `aw_my_availability` / `aw_set_availability` / roster are **operator presence**, not backlog — you don't "resolve" your own DND. So a Call Manager is *Inbox + a presence mode*, and "Queue Manager" is slightly too narrow as the umbrella. The umbrella is the **Desk**: queue-work is the *primary* mode; **presence + directory lookups** are a *secondary capability class* the desk carries (read/set my status, who's available, find a contact/order). Model presence as desk-level operator state, not as items in the queue.

## §6 — The owed step: federate the queues

The horizontal slice only pays off when a Desk holds **multiple bound queues at once** and correlates across them. The real unit of CS work is **cross-site**: a customer *calls* (Aircall) about a *warranty* (VendorSuite) on an *order* (Shopify), tracked as a *ticket* (Zendesk). A per-site manager structurally cannot see that; a Desk that federates can.

**Normalized work-item** (each site maps its rows in; `summarizeItem` is the read side today):

```
WorkItem { source, id, subject, state, owner, url, corrKeys[] }
             │site   │        │       │      │       └ email / phone / order-no → the join across sites
```

`REVIEW_QUEUE` today sweeps one connected queue; the increment sweeps **each connection's** queue and **groups by `corrKeys`** into *issues* — one issue may span a call + a warranty + a ticket. Proposals and the HITL gate operate on the issue, not the isolated row.

## §7 — Built vs owed

| Capability | State |
|---|---|
| TYPE / PRESET / INSTANCE catalog (`appCatalog.js`) | **Built** |
| Object-model reasoning (`<OBJECTS>`, recall-by-grid) | **Built** |
| Per-instance connections (AS-4, a *set*) | **Built** |
| Generic queue console (`REVIEW_QUEUE`/`SHOW_ITEM_SOURCES`, objectModel-keyed) | **Built** |
| Two-tier memory (preset baseline → instance deltas → distill-up) | **Built** |
| Row→`{title,status,id,url}` normalization → federated `WorkItem` (+`source`/`owner`/`corrKeys`) | **Built** (DK-3, v1483 — pure/unwired) |
| Warranty Manager / Call Manager as **presets** | **Built** (DK-1, v1481) |
| Presence capability class — marked + queue-sweep-excluded | **Built** (DK-2, v1482); status UI surface owed |
| **Federated multi-queue + `corrKeys` issue-grouping** | **Built** (DK-4, v1484) — union-find grouping + `SWEEP ▸ federate` trace + gated `<CROSS_SITE_ISSUES>` prompt block; a multi-connection desk is assemblable via the AS-4 wizard, so it's **live-testable now** — issue-steered proposals just not yet eyeballed |

## §8 — Build path

1. **DK-1 ✓ (v2.74.1481)** — *Warranty Manager* + *Call Manager* shipped as Inbox PRESETS (bound object models + prose + baseline). No new TYPE; presets carry no `connections` (site binds per-instance; curated legs are catalog-armed). Proves "site = preset, not type" end-to-end.
2. **DK-2 ✓ (v2.74.1482)** — presence capability class: the availability legs (my/team availability, roster, agent profile, set-availability) carry `capClass:'presence'` (threaded through the ride-recipe hops, Invariant #3) and are **excluded from the queue sweep** — a Call Manager's "review the queue" no longer offers "my availability" as a read nor "set availability" as an action; presence stays a DIRECT interpret capability (`isPresenceLeg`/`partitionDeskLegs`, `Core/palette.js`). *Owed remainder:* surface presence as a standing desk STATUS in the panel.
3. **DK-3 ✓ (v2.74.1483 — pure/unwired)** — the WorkItem normalizer: `toWorkItem(row,{source})` → `{source,id,subject,state,owner,url,corrKeys[]}` + `toWorkItems(result,{source})` (`Core/connectorRender.js`), built on `summarizeItem`. `corrKeys` are typed + normalized (`email:` / `phone:` / `order:`, exact-grouping ready); the owner's OWN contact and free-text bodies are excluded (no agent-merge, privacy lever). Consumed by DK-4 — no federated sweep exists yet, so it's tested but not yet called.
4. **DK-4 ✓ (v2.74.1484)** — federated sweep: `SWEEP_PROPOSE` normalizes every executed read to WorkItems, unions them by shared `corrKeys` into cross-site ISSUES (transitive union-find, `Core/federate.js`), logs `SWEEP ▸ federate → N items → M issues, K cross-site [phone/email/order]`, and feeds the cross-site issues to the propose think as an ADDITIVE, gated `<CROSS_SITE_ISSUES>` block (empty at one connection → the tested single-site sweep is byte-identical, zero regression). *Live-testable now (not dormant):* the AS-4 setup wizard already accretes a SET of sites, so a multi-connection desk is assemblable today — create one on ≥2 sites that share a customer key, sweep, and `SWEEP ▸ federate` fires; the issue-steered proposals are just not yet eyeballed.
5. **DK-5** — cross-site proposals: a proposal may act on >1 site for one issue (e.g. "close the ticket AND wrap the Aircall conversation"), each site's write behind its own confirm belt (§9 connectors).
6. **DK-6 ✓ (v2.74.1486, auto-connect v2.74.1487)** — streamlined desk selection: "New desk" is ONE FLAT LIST — the **preconfigured desks** (each ships `sites` + seed + legs; picking one **auto-connects** its resolvable sites — no picker, straight to "Connected to …"; unresolved sites are named with a `setup`-to-add hint) + a single **Custom desk** (user picks sites; `seed:` sets the role) + *Your desks*. The picker (with pre-picks) remains the ADJUST path — the typed `setup` command / Set-up card. The TYPE level (Inbox/Watcher/Concierge) is **retired from the UX** — `type`/`archetype` persist internally as loop-shape fields, never as a user choice; legacy site-less presets stay resolvable by id but are gallery-hidden (promoting one = giving it `sites`, one data edit). A preconfigured desk's seed stays editable per-instance (`seed` / `seed:` — already synced the durable def). **First preconfigured desk = the Warranty desk** (`warranty-manager`, display "Warranty desk"): VendorSuite + Zendesk + Shopify + HubSpot, seed widened to the homeowner's whole record ("items sharing an email/phone/address are ONE case") — the DK-4 federation's live vehicle. HubSpot ships as a connection with no curated legs yet (harvested reads §20 grow them). Mechanics: `def.sites` (appDef) → `preconfiguredDesks()` (appCatalog) → `seedDeskCatalog` (capableSites: existing instance beats class — deako.zendesk.com pre-picks for zendesk.com; a deep host synthesizes its card absorbing the class card; a bare tenant class with no instance stays a guided type-your-address card).
7. **DK-7 ✓ (v2.74.1488)** — the **`each` mode** (connectors-layer machinery the desk asks ride on): "For each division, list open warranty tasks" is now one plain ask. The model's contract is UNCHANGED — it binds the sentinel (`divisionId:"each"`, taught by the leg's own does/hint); the recipe's `resolve` spec opts in (`each: true` — the enumeration comes from the SAME via-read that resolves one value, different cardinality); the dispatcher fans the READ out deterministically (`_rideEachFanOut`: sequential, capped 16, per-item failure counted not fatal, grouped render + tagged rows grounding follow-ups, `RIDE_EACH ▸` trace). **A write NEVER fans** — one write, one confirm; per-item work belongs to sub-tasks with per-item HITL. Interpretation stays with the model; enumeration + iteration stay in code — the same division of labor as `resolve` itself. Generalizes by data: any enumerable resolve spec (Aircall teams, Zendesk views) is one `each: true` away.

8. **DK-8 ✓ (v2.74.1491)** — **declared ROUTINES** (the workflow-placement decision made concrete): *anything with a trigger + steps + side effects is a first-class object; the seed is its INTAKE, never its home.* The seed states intent in prose ("Daily routine: for each division, list new warranty tasks and open each as a sub-task"); the model-side directive extraction (FL-6b's seam, no regex over the seed) compiles it to a **routine record** (`fleetRoutine:<instanceId>`: {minutes, ask, source, enabled, due, lastFiredAt}) — **OFF until the user enables it** (HITL at declaration; a seed re-edit updates ask/cadence but never flips the user's arm/disarm; a seed that drops it clears only a seed-owned record). `routines` lists it (enable/disable · run now · remove); enabling arms a `fleet-routine:` chrome.alarm. **v1 fire model:** the alarm marks the record DUE (SW); opening the desk runs the ask through the normal panel pipeline (the starter path — each fan-out, sub-task creation, every gate identical to typing it). Headless SW execution is the owed upgrade. The Warranty desk ships the declaration in its seed — visible, editable, off by default. Trace: `ROUTINE ▸ declared/armed/due/fired`.

9. **DK-8e–h ✓ (v2.74.1496–1500)** — **cases are DOSSIERS, presented conversationally** (four live rounds on the Warranty desk). **8e (1496)** — a case is born with its RECORD + identity, not a display label: the fan-out passes `{label, detail, row}` (`fanoutItems`), the child's seed carries a fenced `<CASE_RECORD>` (data, never instructions — the §9 boundary), and the record card is the case's first message; titles drop the `#id` prefix that mis-resolved as a division. **8f (1497)** — the dossier DRILLS at spawn: a list row is a projection; the item's FULL record is fetched per case via the source leg's declared `drill` (best-effort, `RIDE_DRILL ▸ dossier`). **8g (1498–99)** — the single-case test primitive: `fanoutLimit` ("open the first/one/N case(s)") stands in for the foreach quantifier at the fan-out gate, and the dossier carries the record's NARRATIVE (description/notes/vendor-explanation-class fields — a case's own file keeps its narrative; the sweep-privacy lever still excludes bodies from LISTS). **8h (1500)** — the case opens CONVERSATIONALLY: a spawn-time `CASE_BRIEF` think (`Core/caseBrief.js`, cheap tier, best-effort) reframes the dossier in the REQUESTOR's voice — what's wrong, where, how old, what's scheduled, the vendor's note — replacing the raw field-dump card (which stays as the no-LLM fallback), with the full record on demand (the seed's fence + "ask for any field"); the case seed also instructs the child's IL to keep discussing the record conversationally, quoting fields rather than re-dumping them. Non-blocking: cases spawn instantly; briefs land as they arrive (`CASE_BRIEF ▸ N/M framed`). Privacy: the dossier already rides the case's seed to the LLM — the brief opens no new egress channel. **8i (1501)** — the DESK transcript is the operator's LEDGER: a read CONSUMED by a case spawn drops its row dump from the desk (the chain nulls that readout slot; the rows live in the cases), and the spawn line becomes a real meta description (`fanoutSummary`, pure: "Found 13 items from “Warranty tasks by status” → opened the first as a case: “…” — nested under “Warranty desk” in the rail"); a directive fan-out's "N done, K need you" line now survives the chain-end join. A read with NO following spawn still renders its rows (the interrogator behavior); the ephemeral reduce keeps its rows too (its workers close — the parent transcript is where the read survives).

## §9 — Open questions

- **Correlation keys.** email + phone + order-no cover most CS joins; is fuzzy match (near-phone, name) worth it, or exact-only to avoid false merges? Start exact.
- **Preset vs instance for a multi-site desk.** Is "CS Desk (Zendesk + Aircall + VendorSuite + Shopify)" one shipped PRESET, or an INSTANCE a user assembles from connections? Lean: ship a broad preset; let instances narrow.
- **User-declarable object models / identity resolution.** Today `objectModel`, `resolve`/`drill`/`identityGql` are curator-authored. Making them user-settable in the add-leg/forge flow is the generalization that lets *any* site a user connects join a Desk without a catalog edit — a separate, larger track (`DESIGN_connectors.md` §17 harvest is the read half).
- **Presence federation.** One Aircall presence is clear; if a desk connects two comms tools, is there one "available" or per-tool? Per-tool, surfaced together.

## §10 — The FRONT DESK (Overview adopted, v2.74.1507)

The reserved general conversation (internally `OVERVIEW_ID`, unchanged) is displayed as the **Front desk** — the
desk that runs the office: **home** (general asks, choosing where to work), **fleet status** (the Connections card,
§16b of DESIGN_connectors.md), and **the plumbing operator** (sign-in recovery; next: routine ledger, pending gates,
sweep health). Naming rationale: a real front desk greets, knows every desk's status, and calls maintenance — all
three roles in one office noun, completing the Desk/Case/Routine vocabulary ("Overview" said watching, not acting,
and was the odd abstraction out). Boundaries: NOT in the desk gallery (reserved, always exists), takes NO cases
(plumbing produces notices, not cases). Internal tokens (`OVERVIEW_ID`, `isOverview`, `role:'overview'`, the OV-*
workbench markers, `DESIGN_overview.md`) stay — display strings only, same pattern as the Desk and Case adopts.
