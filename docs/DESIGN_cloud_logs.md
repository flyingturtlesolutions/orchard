# DESIGN_cloud_logs.md — CloudWatch log shipping for the Orchard fleet (CW)

**Intent (one line):** every Orchard instance can mirror its runtime log stream to CloudWatch Logs — through
the Orchard cloud API, never with AWS credentials in the client — so the fleet becomes observable in one
place, while the local ring stays the authoritative debugging surface.

Written 2026-07-31 from the observability review ("is CloudWatch implemented?" — it wasn't: zero client
references, no infra module in AWS_INTEGRATION.md §10, only implicit Lambda log groups on the deployed
stack). Companion to `docs/orchard/specs/AWS_INTEGRATION.md` (the shared docs tree); §12 below lists the
amendments that spec needs.

---

## 1. What ships

Orchard has three log-shaped streams today:

| Stream | Source | Ships? |
|---|---|---|
| **Runtime trace** | `Core/Logger.js` ring (DEBUG/INFO/WARN/ERROR + the WARN/ERROR sidecar) — what a `gl` download exports | **Yes — this is the product.** |
| **Decisions view** | The same ring filtered through `_DECISION_RE` (the `gc` story view) | Yes, as a client-side LEVEL (a filter, not a second pipeline) |
| **Chat transcripts** | `_downloadChats()` | **Never.** Conversation content is not telemetry. |

`logs/build/` (the conversation journal) and `findings.md` are development artifacts of THIS repo's build
loop, not instance logs — they never ship.

## 2. Rulings

1. **No AWS credentials in the client, ever.** The extension egresses logs ONLY through the authenticated
   Orchard API (`POST /v1/logs/batch`); a backend Lambda holds the sole `logs:PutLogEvents` grant. No Cognito
   Identity Pool federation, no SigV4 in the extension — the client's AWS surface stays exactly what
   AWS_INTEGRATION.md already defines: "the client only ever talks to the API."
2. **Opt-in, three levels, default OFF.** `cloudLogs: 'off' | 'decisions' | 'full'` in settings. `off` is the
   shipped default — the current local-only posture is a privacy stance, not an accident. `decisions` ships
   only `_DECISION_RE`-matching lines (the signal view); `full` ships INFO+ (DEBUG stays local — it is volume,
   not signal). Flipping the setting takes effect at the next flush; turning it off also drops the pending
   outbox (a kill switch, not a drain).
3. **Only the scrubbed ring ships.** `Logger.#scrubEntry` runs at APPEND time (v2.74.190 lineage) — emails,
   phones, UUIDs, record ids are already gone before an entry touches storage, so the shipper reads the same
   sanitized entries a `gl` download exports. The shipper adds NO second scrubber and NO unscrubbed side
   channel; if a new field family ever bypasses scrub-at-append, that is a Logger bug to fix there, not
   compensated for here. (The injection/privacy boundary docs govern: fencing ≠ redaction.)
4. **Bound identity required.** Shipping requires a cloud-bound identity (OrchardAuth): the stream name is
   `{orchardUserId}/{installId}`. An unbound install has nothing to ship as — no anonymous ingestion channel
   exists, so the fleet view never contains logs nobody can be accountable for.
5. **The local ring remains authoritative.** CloudWatch is a MIRROR with retention, not the system of record:
   the `gl`/`gc`/findings loop is unchanged, byte-for-byte. Cloud outage, quota drop, or `off` never degrades
   local debugging.
6. **Never block the app.** The shipper is fire-and-forget behind the ring: enqueue is synchronous and
   bounded, flush is alarm-driven, every failure path drops toward LOCAL-ONLY (oldest batches evicted first)
   with one WARN line per hour maximum about its own health. A logging pipeline that can stall the app is a
   worse bug than any it could ever report.
7. **The manifest version rides every event** (plus `installId`, `channel: sw|panel|studio`). Version is the
   fleet join key — the same discipline as `logs/` locally, where version joins build ↔ run ↔ commit.

## 3. Architecture

```
Logger ring (scrubbed, MAX_STORED)            ── existing, untouched
      │  tail-tap (post-persist hook)
      ▼
CloudLogOutbox (chrome.storage.local, bounded)   Services/Cloud/CloudLogShipper.js
      │  chrome.alarms flush (60s; SyncEngine's outbox pattern)
      ▼
POST /v1/logs/batch  (CloudClient, Cognito session auth)
      ▼
orchard-api Lambda ── validates size/shape/level ──► CloudWatch Logs PutLogEvents
                                                      log group  /orchard/{env}/client
                                                      log stream {orchardUserId}/{installId}
```

- **Tail-tap, not a fork:** the shipper subscribes to the same post-persist point that broadcasts
  `LOG_ENTRY` to live viewers. It sees exactly what storage sees — scrubbed, leveled, ordered.
- **Outbox:** entries append to a bounded outbox (default cap 2,000 events / ~1MB). Overflow evicts oldest
  whole batches (never partial — a batch is an ordering unit). Flush every 60s when non-empty, immediate
  flush on WARN/ERROR arrival (errors are what the fleet view is FOR), jittered ±10s so a fleet doesn't
  synchronize.
- **Batch shape** (client → API): `{ installId, version, level, events: [{t, lvl, tag, msg}] }`, capped at
  500 events / 800KB per call (inside PutLogEvents' 1MB/10k limits with headroom). Timestamps are client
  epoch-ms; the Lambda drops events older than 13 days or >1h future (CloudWatch's -14d/+2h window, with
  margin) and reorders within the batch if needed.
- **Lambda duties:** auth (session → orchardUserId), stream get-or-create, size/shape enforcement, level
  allow-list, per-user rate limit (see §7), PutLogEvents (no sequence tokens — post-2023 API), structured
  429/413 rejections the client backs off on (exponential, cap 15min).

## 4. Backend module — `orchard-observability` (closes the §10 gap)

| Resource | Detail |
|---|---|
| Log group `/orchard/{env}/client` | KMS CMK (workspace key or a dedicated obs CMK — DD below), retention **30d dev / 90d prod** |
| Log group hygiene for the stack's own Lambdas | explicit groups + retention for `orchard-api` functions (today they auto-create with never-expire) |
| Metric filters | `ERROR` count · `HEAL ▸ suspect` · `CADENCE ▸ (fired\|auto-disarmed)` · `VITALS ▸ case opened` — the markers the decisions view already treats as signal |
| Alarms | client ERROR rate anomaly · api Lambda errors · API 5xx · DDB throttles |
| Dashboard | fleet: events/min by level, ERROR top-K by version, active instances (distinct streams), heal/cadence/vitals marker rates |
| Insights | saved queries: "errors by version", "one instance's day", "marker timeline for install X" |

Per-env accounts and `us-east-1` per AWS_INTEGRATION DD-13. Subscription filter → Firehose → S3 is explicitly
**out of scope for v1** (retention covers the need; long-term archive is a later DD).

## 5. Privacy and consent

- **Consent surface:** the setting lives with the other cloud toggles; enabling `full` shows a one-time
  confirm naming exactly what leaves the machine ("your Orchard activity log — scrubbed of emails, phones,
  ids — not page content, not conversations"). The Admin desk vitals card shows a standing `cloud logs: on
  (full)` line while enabled — shipping is never invisible.
- **Workspace/org policy (P2+ world):** an org workspace MAY require `decisions` minimum for member installs
  (fleet supportability) but can never force `full` — full-trace shipping stays an individual consent.
- **What CloudWatch holds** is what a shared `gl` trace holds today (already the shareable artifact) — the
  scrub boundary is the SAME. The delta is durability + aggregation, which is why retention is short and
  access is IAM-scoped to the ops role, not to workspace members.
- **Right to vanish:** unbind (or `off`) stops shipping immediately; a delete request is an ops runbook
  action (delete the install's stream). Retention bounds the tail either way.

## 6. Failure semantics

| Failure | Behavior |
|---|---|
| Offline / API down | outbox accumulates → evicts oldest batches at cap; one WARN/hour |
| 401/403 (session lapsed) | pause shipping, mark `needs-auth`; resume on next successful cloud auth |
| 429/413 | exponential backoff (cap 15min); halve batch size on 413 |
| Clock skew beyond window | Lambda drops the stragglers, reports `dropped` count in the response; client logs one WARN |
| Storage pressure | outbox cap is absolute; the ring's own eviction is untouched |

## 7. Cost envelope (why levels + caps are shaped this way)

CloudWatch ingestion ≈ $0.50/GB, storage ≈ $0.03/GB-mo. A busy instance's full INFO+ trace runs ~1–3MB/day
(today's traces: ~70 lines/min at peak, mostly DEBUG which does NOT ship); `decisions` runs ~30–100KB/day.
So: 1,000 instances on `decisions` ≈ 0.1GB/day ≈ **~$2/mo ingest** — negligible; 1,000 on `full` ≈ 2GB/day ≈
**~$35/mo ingest + storage** — fine, but the per-user rate limit (default 5MB/day/install, Lambda-enforced)
keeps a pathological logger from becoming a bill. DEBUG shipping is refused server-side, not just unsent.

## 8. Relationship to the build loop

`gl`/`gc` and `findings.md` are unchanged — local traces stay the debugging system of record (§2.5). What
CloudWatch adds is the FLEET question the local loop cannot answer: "did v2.74.X regress anyone else?",
"how often does `HEAL ▸ suspect` fire outside this machine?", "which versions are alive?" Metric filters
deliberately reuse the decisions-view markers so the fleet dashboard speaks the same vocabulary as a `gc`
skim. **Invariant #1 extends:** a new decision marker added to `_DECISION_RE` should be considered for a
metric filter in the same change (add it to the §4 filter list or say why not).

## 9. Build ladder

| Rung | Builds | Depends on | Risk |
|---|---|---|---|
| **CW-1** | `orchard-observability` infra module: log group, KMS, retention, api-Lambda log hygiene | backend repo | low |
| **CW-2** | `POST /v1/logs/batch` Lambda (auth, limits, PutLogEvents) + AWS_INTEGRATION §7 row | CW-1 | low |
| **CW-3** | Client: `Services/Cloud/CloudLogShipper.js` (tail-tap, outbox, alarm flush, backoff) + the `cloudLogs` setting, `decisions` level only | CW-2, bound identity | medium (MV3 alarm + storage discipline) |
| **CW-4** | `full` level + consent confirm + vitals "shipping on" line + org minimum-policy hook | CW-3 | low |
| **CW-5** | Metric filters + alarms + dashboard + saved Insights queries | CW-1 | low |
| **CW-6** | Ops runbook: stream delete (right-to-vanish), quota tuning, the §8 marker↔filter sync check | CW-2..5 | low |

Client rungs land in this repo; infra rungs in the backend repo. CW-3 is the only rung touching extension
runtime behavior — it follows the SyncEngine outbox/alarm pattern that already survives MV3.

## 10. Open questions (design register)

- **DD-CW-1:** dedicated observability KMS CMK vs reusing the workspace CMK (isolation vs key sprawl).
- **DD-CW-2:** does `decisions` level become the org-workspace DEFAULT (not just minimum) once workspaces
  ship? (Supportability vs consent-surface creep.)
- **DD-CW-3:** long-term archive (Firehose→S3) — only if a real retention need appears; not v1.
- **DD-CW-4:** should Studio's log viewer grow a "fleet" tab reading Insights through the API? (Read path —
  separate consent story, separate rung; not specced here.)

## 11. Amendments owed to AWS_INTEGRATION.md

1. §10 table: add the `orchard-observability` module row (per §4 above).
2. §7 API surface: add `POST /v1/logs/batch` (auth: session; body/limits per §3).
3. §12 register: add DD-CW-1..4.
4. §11 rollout: CloudWatch shipping slots at **P1.5** (needs auth from P0, ships value before P2).
