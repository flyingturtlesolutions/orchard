# DESIGN_app_fleet — the FLEET app (workflow-anchored)

**Status:** FL-1..5 BUILT v2.74.1346 (propose-only sweep · pending queue · gated executor + staleness CAS · action
ledger · `ticket-manager` preset). FL-6 (clock trigger) pending. Live verification owed (needs the real queue).

**The build discipline this doc exists to enforce (2026-07-07, the "this is all wrong" correction):** we build
workflows, not abstract infrastructure — but the workflow's *intelligence* is never code. Everything the app "knows"
is either the model's judgment, a memory rule (taught/learned), or the type's baseline DATA. The code below is a
GENERIC harness any fleet app reuses.

## 1. The workflow (the anchor)

A ticket manager that reviews the queue, merges duplicates, closes resolved tickets, and assigns tickets — with the
chat as its console: direct it ("assign billing to Sara"), review it ("how many merges in the last hour?"), and
approve its actions. Later: on a clock (FL-6). The conversation is the app's CONTROL PLANE, not where the work
happens (DESIGN_conversations.md §6A still holds; this doc adds the run shape).

## 2. The app is data

- **Seed** — the goal, propose-only phrasing (the `ticket-manager` preset, Core/appCatalog.js).
- **Fence** — setup-banked connections + `writePolicy: 'gated'`.
- **Baseline** — a few generalizable behavior RULES in preset memory (merge-into-older, replied≠resolved,
  never-invent-assignees). Overridable, visible via `memory`, never compiled.
- **Everything domain-specific is TAUGHT, not shipped**: what "duplicate"/"resolved" mean here, routing rules,
  exclusions — `remember:` turns and reasoned rejections (each banked as an observation-tier delta the ratchet
  corroborates).

## 3. The run: sweep → propose → approve → execute → ledger

- **FL-1 · Sweep (SWEEP_PROPOSE, background/handlers/sg.js).** Two think seams (Core/sweepPrompt.js, pure+tested):
  phase A offers the app's connector READ legs → the model picks ≤3 reads (validated against the offer); the panel
  executes them (`_runConnectorLeg`); phase B offers the ACT legs + the results (fenced DATA) → validated PROPOSALS.
  The palette is connector-domain (curated for the connections + harvested + broker), `policyFilter`ed — the
  `forbidden` floor holds. Anti-hallucination: every pick must resolve to an offered leg (Core/proposals.js
  `normalizeProposal`), at most one proposal per target, ≤20 per run.
- **FL-2 · Pending queue (Services/Storage/ProposalStore.js, `proposals:{instanceId}`).** Proposals park with
  status pending → approved/rejected/executed/stale/failed. Chat renders the numbered batch with per-item ✓/✗
  (once-guard) + "Approve all safe" — bulk covers safety `auto|confirm` ONLY; a `gated` (destructive-class)
  proposal always takes its own click. Verbs: `sweep` · `pending` · `approve all` / `approve 1,3` /
  `reject 2 <why>`. A reasoned rejection is a learning signal (recordGoalItem, provenance `proposal-reject`).
- **FL-3 · Executor (chat.js `_approveProposal`).** The approval click IS the CX-6 confirm: execution dispatches
  the proposal's leg through the EXISTING write path with `confirmed:true` — one HITL per action, moved from a
  modal bar to the queue; the fail-closed contract holds at both ends. **Staleness CAS:** a proposal carries
  `basedOn {readKey, path, value}` + its grounding read; execution re-runs the read and REFUSES (status `stale`)
  if the anchor moved — never act on a queue another human is also working (the canvas `ifRev` pattern).
- **FL-4 · Ledger (Services/Storage/ActionLedgerStore.js, `ledger:{instanceId}`; pure half Core/actionLedger.js).**
  Append-only sweep/proposal/decision/execution entries, provenance captured AT ACT TIME. Console: `ledger`
  (+`hour`/`today`) → totals + executed-by-action + recent lines. This is the trust instrument and, later, the
  earned-autonomy ratchet's evidence base (approval/reversal counts per rule → per-action-class unattended trust —
  deliberately NOT built yet).

## 4. Invariants honored (don't relearn)

- **Instance-keyed keyspaces** — `proposals:{instanceId}`, `ledger:{instanceId}` (never appId; the
  `canvas:sources:{appId}` lesson). Not sync-registered until StoragePaths carries instance-keyed records.
- **`SWEEP ▸` is in `_DECISION_RE`** (studio.js) — sweeps are verifiable from a decisions download.
- **Injection boundary** — tool lines sanitized; read results fenced as `<SWEEP_DATA>` data-not-instructions;
  proposal text renders through the escape-first markdown path.
- **No busy-marking needed** — sweeps ride connector fetches, never engine-driven DOM clicks.

## 5. The portability test (falsifiable)

Same four primitives + a different seed ("keep my inbox at zero…") + a Gmail connection ⇒ an inbox fleet app with
ZERO new code. If a new fleet app needs code, intelligence leaked into the harness and that leak is a bug.

## 6. Next slices

- **FL-6 · Clock trigger** — `chrome.alarms` swaps in for the `sweep` verb; the loop doesn't change. Needs the
  queue to be reachable headless (session-ride ⇒ "runs while the site's tab is open" is the honest v1 constraint).
- **FL-7 · Earned autonomy** — per action-class promotion (N approvals, 0 reversals → one HITL "always do this?" →
  auto within the fence), reversal detection as demotion. Reads the ledger; reuses the promotion gate.
- **Live verification** — the sweep on the real Deako queue (proposal quality, param binding on the write legs,
  staleness behavior under concurrent agent activity).
