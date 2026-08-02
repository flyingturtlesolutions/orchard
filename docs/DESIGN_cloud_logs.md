# DESIGN_cloud_logs.md — CloudWatch log shipping for the Orchard fleet (CW)

**Intent (one line):** every Orchard instance can mirror its runtime log stream to CloudWatch Logs — through
the Orchard cloud API, never with AWS credentials in the client — so the fleet becomes observable in one
place, while the local ring stays the authoritative debugging surface.

Amended 2026-07-31 (LDD review): retrieval endpoint in the gl grammar (CW-7), the shared decision-marker
manifest, per-event JSON structure, in-stream gap markers — and the ruling that `full` includes DEBUG by
default (no elevation machinery; revisit only if cost bites).

Amended 2026-07-31 (the mailbox): **CW-8** — a scheduled exporter mirrors the client log group into a private
git repo in the gl grammar, so any Claude Code on any machine reads the fleet with `git pull` and nothing
else: no AWS credentials, no Chrome, no extension, no human in the loop. §12 specs it; §5 gains the rotation
ruling the mailbox's durability forces; CW-8a (§12.10) names the three-implementation drift in the line
grammar that CW-7's "byte-compatible" claim was already papering over.

Written 2026-07-31 from the observability review ("is CloudWatch implemented?" — it wasn't: zero client
references, no infra module in AWS_INTEGRATION.md §10, only implicit Lambda log groups on the deployed
stack). Companion to `docs/orchard/specs/AWS_INTEGRATION.md` (the shared docs tree); §11 below lists the
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
   only manifest-matching lines (the signal view); `full` ships the WHOLE ring, **DEBUG included** (user
   ruling: the dispatch layer is where recent diagnoses actually lived — the TDZ proof and the render-churn
   measurement were both DEBUG reads; volume is a cost problem and cost is what quotas are for — revisit only
   if it bites). Flipping the setting takes effect at the next flush; turning it off also drops the pending
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
7. **The manifest version rides EVERY EVENT** (`v` per event, never per batch — a batch can straddle an
   update; per-event never lies), plus `installId` and `channel: sw|panel|studio`. Version is the fleet join
   key — the same discipline as `logs/` locally, where version joins build ↔ run ↔ commit.
8. **One marker manifest, two derivations (the anti-drift ruling).** `Core/decisionMarkers.js` becomes the
   single source of decision-marker truth: `[{ key, re, metric, alarm, since }]`. `_DECISION_RE` (studio.js)
   is BUILT from it, and the infra metric filters are GENERATED from it
   (`tools/observability/gen-filters.cjs` emits an artifact the backend repo consumes; CI fails on
   staleness). Without this, filters hand-written in another repo re-create invariant #1's failure family at
   fleet scale — a new marker structurally invisible on the dashboard. Invariant #1's rule becomes: add the
   marker to the MANIFEST; both worlds follow. A conformance check greps source for markers absent from it.
9. **The trace records its own incompleteness.** Any client-side eviction enqueues one synthetic
   `SHIPPER ▸ gap — dropped N events (from–to, reason)` WARN event; server-side clock drops surface the same
   way from the Lambda's response counts. A fleet trace must never read as complete when it is not (the
   verification-honesty discipline applied to the pipeline itself). Eviction is MIDDLE-OUT, never
   evict-oldest: keep the head batches (the ONSET — where causes live) and the newest (current state), drop
   between (`KEEP_HEAD_BATCHES = 4`). `SHIPPER ▸` joins the manifest (metric: true) so the dashboard shows
   the pipeline's own loss rate.

## 3. Architecture

*Visual: [diagram_cloud_logs_pipeline.svg](diagram_cloud_logs_pipeline.svg) — the whole flow, extension ring →
CloudWatch → CW-8 git mailbox → a Claude Code conversation, with the panel-download lane beside it (payloads +
chats never ship). Self-contained SVG, light/dark aware; measured event→git latency 69 s (2026-07-31).*

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
- **Batch shape** (client → API): `{ installId, level, events: [{t, lvl, tag, msg, v}] }` — `v` per event
  (ruling 7), capped at 500 events / 800KB per call (inside PutLogEvents' 1MB/10k limits with headroom).
  Timestamps are client epoch-ms; the Lambda drops events older than 13 days or >1h future (CloudWatch's
  -14d/+2h window, with margin), reorders within the batch if needed, and reports drop counts back.
- **Events are stored as JSON lines**, with the Lambda stamping `marker: '<manifest key>'` on matching
  events (it holds the generated manifest artifact) — Insights queries become field filters
  (`filter marker='cadence-fired' and v='2.74.1816' | stats count() by v`), never regex archaeology over
  prose. The CW-7 exporter re-flattens JSON to the gl line grammar: structure in the store, prose in the
  file.
- **Lambda duties:** auth (session → orchardUserId), stream get-or-create, size/shape enforcement, marker
  stamping, per-user rate limit (see §7), PutLogEvents (no sequence tokens — post-2023 API), structured
  429/413 rejections the client backs off on (exponential, cap 15min).

## 4. Backend module — `orchard-observability` (closes the §10 gap)

| Resource | Detail |
|---|---|
| Log group `/orchard/{env}/client` | KMS CMK (workspace key or a dedicated obs CMK — DD below), retention **30d dev / 90d prod** |
| Log group hygiene for the stack's own Lambdas | explicit groups + retention for `orchard-api` functions (today they auto-create with never-expire) |
| Metric filters | GENERATED from `Core/decisionMarkers.js` (ruling 8): `ERROR` count · `HEAL ▸ suspect` · `CADENCE ▸ (fired\|auto-disarmed)` · `VITALS ▸ case opened` · `SHIPPER ▸ gap` · every manifest entry with `metric: true` |
| Alarms | client ERROR rate anomaly · api Lambda errors · API 5xx · DDB throttles |
| Dashboard | fleet: events/min by level, ERROR top-K by version, active instances (distinct streams), heal/cadence/vitals marker rates |
| Insights | saved queries: "errors by version", "one instance's day", "marker timeline for install X" |
| Retrieval (CW-7) | `GET /v1/logs/export?install&from&to&level` returns the EXACT local gl line grammar (`HH:MM:SS.mmm LEVEL tag msg` + a header naming instance/version/window). Window ≤24h, response ≤10MB, paginated. Ops-scoped + self-service (an install always exports its own streams). Client counterpart: `tools/fleet-trace/pull.cjs` ("glf") writes `logs/run/orchard-logs-fleet-<install8>-<stamp>.txt` — the findings workflow applies byte-for-byte |

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
- **The mailbox forgets on a cadence (CW-8 ruling).** The scrub boundary of the git mirror is identical — it
  holds exactly what the stream holds — but its DURABILITY is not: CloudWatch forgets after 90 days and is
  IAM-scoped, while git history is permanent and every clone carries it to another machine. Retention is the
  bound this section leans on, so the mailbox must have one: the repo **rotates quarterly** (archive or delete
  the old one, start a fresh one), and nothing in it outlives its CloudWatch source by more than a quarter. A
  vanish request inside the window is then a history rewrite on ONE small short-lived repo rather than
  archaeology across years of clones. Consumers clone shallow (§12.9) — the payload is the current files, not
  the export history.

## 6. Failure semantics

| Failure | Behavior |
|---|---|
| Offline / API down | outbox accumulates → MIDDLE-OUT eviction at cap (ruling 9: onset + tail survive) with an in-stream `SHIPPER ▸ gap` marker; one WARN/hour |
| 401/403 (session lapsed) | pause shipping, mark `needs-auth`; resume on next successful cloud auth |
| 429/413 | exponential backoff (cap 15min); halve batch size on 413 |
| Clock skew beyond window | Lambda drops the stragglers, reports `dropped` count in the response; client logs one WARN |
| Storage pressure | outbox cap is absolute; the ring's own eviction is untouched |

## 7. Cost envelope (why levels + caps are shaped this way)

CloudWatch ingestion ≈ $0.50/GB, storage ≈ $0.03/GB-mo. With DEBUG included (ruling 2), a busy instance's
`full` trace runs ~3–10MB/day (today's traces: ~70 lines/min at peak, DEBUG-dominated); `decisions` runs
~30–100KB/day. So: 1,000 instances on `decisions` ≈ 0.1GB/day ≈ **~$2/mo ingest** — negligible; 1,000 on
`full` ≈ 3–10GB/day ≈ **~$50–150/mo ingest + storage** — acceptable, and the per-install quota (default
**20MB/day**, Lambda-enforced) caps a pathological logger. If fleet-scale cost ever bites, the levers are
the level default and the quota — the ruling is "will change if need be", not never.

## 8. Relationship to the build loop

`gl`/`gc` and `findings.md` are unchanged — local traces stay the debugging system of record (§2.5). What
CloudWatch adds is the FLEET question the local loop cannot answer: "did v2.74.X regress anyone else?",
"how often does `HEAL ▸ suspect` fire outside this machine?", "which versions are alive?" Metric filters
deliberately reuse the decisions-view markers so the fleet dashboard speaks the same vocabulary as a `gc`
skim. **Invariant #1 is restructured by ruling 8:** a new decision marker is added to `Core/decisionMarkers.js` —
`_DECISION_RE` and the metric filters both DERIVE from it, so a marker cannot be visible in one world and
invisible in the other. The manifest's conformance check makes forgetting grep-visible.

## 9. Build ladder

| Rung | Builds | Depends on | Risk |
|---|---|---|---|
| **CW-1** | `orchard-observability` infra module: log group, KMS, retention, api-Lambda log hygiene | backend repo | low |
| **CW-2** | `POST /v1/logs/batch` Lambda (auth, limits, PutLogEvents) + AWS_INTEGRATION §7 row | CW-1 | low |
| **CW-3** | Client: `Services/Cloud/CloudLogShipper.js` (tail-tap, outbox, alarm flush, backoff) + the `cloudLogs` setting, `decisions` level only | CW-2, bound identity | medium (MV3 alarm + storage discipline) |
| **CW-4** | `full` level + consent confirm + vitals "shipping on" line + org minimum-policy hook | CW-3 | low |
| **CW-5** | Metric filters + alarms + dashboard + saved Insights queries | CW-1 | low |
| **CW-3a** | `Core/decisionMarkers.js` manifest + `_DECISION_RE` derivation + conformance check + `gen-filters.cjs` | — (client repo; CW-5 consumes the artifact) | low |
| **CW-6** | Ops runbook: stream delete (right-to-vanish), quota tuning | CW-2..5 | low |
| **CW-7** | Retrieval: `GET /v1/logs/export` (gl grammar) + `tools/fleet-trace/pull.cjs` ("glf") — the rung that lets fleet traces ENTER the findings loop | CW-2 | low |
| **CW-8** | The log mailbox (§12): `orchard-log-exporter` Lambda + `rate(1 minute)` tick + `rate(1 hour)` reconciliation sweep + the private `orchard-fleet-logs` repo + the first two alarms in the stack | CW-2 (stored JSON), CW-7 (`glLine`) | medium (git-data-API commit assembly, GitHub rate budget, backfill semantics) |
| **CW-8a** | Grammar conformance (§12.10): one owner for the gl line, a golden-line test, the UTC-vs-local divergence stated or resolved | CW-7 | low |

Client rungs land in this repo; infra rungs in the backend repo. CW-3 is the only rung touching extension
runtime behavior — it follows the SyncEngine outbox/alarm pattern that already survives MV3. CW-8 touches
nothing the extension runs: it is entirely a robot on the AWS side plus a repo, which is why it can land
without a version bump on this side.

## 10. Open questions (design register)

- **DD-CW-1:** dedicated observability KMS CMK vs reusing the workspace CMK (isolation vs key sprawl).
- **DD-CW-2:** does `decisions` level become the org-workspace DEFAULT (not just minimum) once workspaces
  ship? (Supportability vs consent-surface creep.)
- **DD-CW-3:** long-term archive (Firehose→S3) — only if a real retention need appears; not v1.
- **DD-CW-4:** should Studio's log viewer grow a "fleet" tab reading Insights through the API? (Read path —
  separate consent story, separate rung; not specced here.)
- **DD-CW-5:** rotation MECHANICS (§5, §12.6) — a new repo per quarter (`orchard-fleet-logs-2026q4`, so the
  exporter's target name is config) vs. truncating history in place on one permanent repo (an orphan commit + force
  push, so consumers' remotes never change). The ruling that it rotates is settled; how is not.
- **DD-CW-6:** does the mailbox retire `tools/fleet-trace/pull-cloudshell.sh`, or does the CloudShell pull
  stay as the sub-minute "live wire" (§12.2 ruling 1)? Keeping it means a THIRD flattener survives, which
  CW-8a would rather kill.

## 11. Amendments owed to AWS_INTEGRATION.md

1. §10 table: add the `orchard-observability` module row (per §4 above).
2. §7 API surface: add `POST /v1/logs/batch` and `GET /v1/logs/export` (auth: session; body/limits per §3/§4).
3. §12 register: add DD-CW-1..6.
4. §11 rollout: CloudWatch shipping slots at **P1.5** (needs auth from P0, ships value before P2).
5. §10 table: add the `orchard-log-exporter` function, its two EventBridge schedules, the
   `orchard/fleet-logs-github-token` secret, and the two alarms (per §12) — note it is the ONLY component
   with an egress path out of the AWS account that is not the client API.

## 12. CW-8 — the log mailbox (a private git repo the fleet writes to)

**Intent (one line):** a small robot on the AWS side wakes every minute, copies new fleet events out of
CloudWatch into a private GitHub repo as plain gl-grammar text files, and from then on any Claude Code
anywhere gets the fleet with `git pull` — the same way it gets code.

CW-7 made a fleet trace *pullable* by someone sitting in CloudShell with AWS credentials. CW-8 makes it
*ambient*: the consumer needs only the git credentials it already has for the other private repos. No AWS
keys on the reading machine, no Chrome, no extension, no human in the loop.

### 12.1 Shape

```
EventBridge rate(1 minute)  ── tick  ─┐
EventBridge rate(1 hour)    ── sweep ─┴─► orchard-log-exporter  (Lambda, reservedConcurrency 1)
                                            │ 1. FilterLogEvents over /orchard/dev/client (lookback window)
                                            │ 2. nothing new? EXIT — no GitHub call, no commit, no noise
                                            │ 3. flatten with glLine() — the SAME function /logs/export uses
                                            │ 4. group by stream × UTC hour → whole-file bodies
                                            │ 5. diff against the tree; unchanged files drop out
                                            │ 6. ONE commit (git data API): files + watermark together
                                            ▼
                        github.com/flyingturtlesolutions/orchard-fleet-logs   (private)
                                            │
                                            ▼   git clone --depth 1  /  git pull
                        any machine · any Claude Code · no AWS
```

### 12.2 Rulings

1. **Poll, never push.** `rate(1 minute)` — EventBridge's floor — with a commit-only-on-new guard, so idle
   minutes cost one CloudWatch call and produce no commits. The client's own flush alarm (60s, jittered ±10s)
   sets the real latency floor, so a minute tick lands within ~30s of it. The full budget and the recorded
   rejection of the push design are §12.2a. **The mailbox is ambient memory, not the live wire.** The live
   wire is the panel itself, and CloudShell for someone else's install.
2. **A mirror of a mirror.** §2.5 rules CloudWatch a mirror rather than the system of record; the repo is one
   hop further out. It can be deleted and rebuilt from CloudWatch at any point inside retention, nothing may
   read it as authoritative, and nothing writes to it but the exporter.
3. **`full`, and the exporter does not re-filter.** It writes whatever each stream holds at whatever level
   that install consented to. Filtering at export would make the mailbox lie about what CloudWatch has, and
   the decisions view is a READ-side filter everywhere else in this system (§1) — `grep` over an hour file is
   the mailbox's `gc`. The cost of the ruling is §12.5's growth math; rotation (§5) is the bound.
4. **Whole-hour rewrite, never append — idempotence by construction.** The unit of write is "every event this
   stream has in this UTC hour, as of now." A rerun over the same window therefore produces byte-identical
   files, which git turns into a no-op — so a duplicated tick, a retried invocation, a widened sweep and a
   manual replay are all free and safe, and a late arrival lands in timestamp order instead of at the end.
   Append-only would make each file a function of WHEN it was written rather than what CloudWatch holds.
5. **Two cadences, because backfill is not jitter.** The client outbox survives offline periods, so an install
   that was dark for three hours ships events *timestamped* three hours ago. CloudWatch queries filter on
   event timestamp, not ingestion time — so a watermark that advances to "now" loses backfill **silently**,
   the exact failure §2.9 forbids (a trace must never read complete when it is not). The tick scans a SHORT
   lookback (15 min, covering normal shipper jitter); an hourly SWEEP re-scans 48h and rewrites whatever it
   finds different. Ruling 4 is what makes the sweep almost always cost nothing.
6. **One commit per run — the git DATA api, not the contents api.** The contents API writes exactly one file
   per commit, which would make a multi-file run non-atomic: a mid-run failure leaves half the hour files
   written and the watermark either stale or advanced past unwritten data. Blobs → tree → commit → ref update
   is ~40 lines more and buys the property the whole design rests on: **the watermark advances if and only if
   the files it describes landed.** On a stale-parent 409 (a manual commit, the rotation job), re-read the ref
   and rebuild once.
7. **CloudWatch first; GitHub only when there is something to write.** Reading the watermark from the repo as
   the run's first act — the obvious design — would spend 1,440 GitHub requests/day learning that nothing
   happened. Inverted: query the fixed lookback (free, and needs no state), and touch GitHub only if events
   came back. The watermark still LIVES in the repo (the mailbox records how full it is — self-contained and
   auditable) but is read on cold start, held in the warm container between ticks, and re-read after any
   conflict. It is a scan-floor hint and an audit record; **ruling 4 is the correctness mechanism, not it.**
8. **One function, one asset, one flattener.** The exporter is a separate `lambda.Function` pointed at the
   SAME `lambda/api/` asset with its own handler entry, so it `require`s `logsExport.cjs`'s `glLine`
   directly — sharing by construction, not by discipline. CDK dedupes the asset upload, so the second
   function costs nothing to ship. A second copy of the grammar is precisely the drift CW-8a exists to stop.
9. **No new dependency, no git binary.** Node 20's global `fetch` against the REST API. The api Lambda is a
   plain asset directory with no bundler, so every dependency is hand-packed `node_modules` — the exporter
   must not be the reason that starts. (Octokit would buy nothing here: this is six endpoints.)
10. **The exporter can read and nothing else.** Log-group reads on one group, one secret, and no write path
    back into the Orchard account (§12.8). Its blast radius on failure or compromise is the mailbox.

### 12.2a Latency budget, and the push design (recorded as rejected)

Measured end to end — from "the line is written on the user's machine" to "it is readable in the mailbox":

| Design | Adds | End-to-end | Verdict |
|---|---|---|---|
| `rate(1 hour)` | 0–60 min | up to ~61 min | too slow to be ambient — at that lag you reach for CloudShell instead, which defeats the rung |
| `rate(1 minute)` | 0–60 s | ~30 s–2 min, ~1 min typical | **chosen** |
| subscription filter → buffer → exporter | ~5–40 s | typically <1 min; an ERROR in ~15–30 s | rejected, below |

The floor is not the schedule, it is the CLIENT. And for the events that matter most the gap narrows further:
WARN/ERROR bypass the flush wait entirely (§3, immediate flush), so an error's latency under the poll is
ingest + 0–60s ≈ **~30s median**, against push's ~15–30s. Buying that ~15s is the entire case for push, and
it costs more than the sketch suggests:

- **It is not free, and not two parts.** A subscription filter may only target Kinesis Data Streams, Firehose,
  or Lambda — **SQS is not a valid destination.** So the buffered shape is either filter → Kinesis → Lambda
  (batching window on the event source, plus an always-on stream at ~$11–29/month provisioned or on-demand),
  or filter → relay Lambda → SQS → exporter (genuinely pennies, but FOUR components instead of two).
- **It makes the pipeline stateful and lossy.** Polling re-derives everything from CloudWatch, so a failed run
  is a no-op the next run heals (ruling 4). Push shows each event ONCE: a failed batch is gone unless a DLQ
  catches it, and the whole-hour rewrite degrades into a read-modify-write against the repo on every batch.
  CloudWatch stops being the replayable source of truth — §2.5's posture, abandoned one layer down.
- **What push would genuinely buy, besides seconds:** subscription filters fire on INGESTION, not event
  timestamp, so backfill from an install that was dark for hours arrives immediately and in order — the
  tick/sweep split (ruling 5) would be unnecessary. That is the real argument for push, and notably it is an
  argument about *correctness*, not latency. It still loses: ruling 4 already makes backfill correct, just an
  hour late for the rare offline install, which is exactly the right thing to be slow about.

**If sub-minute ever truly matters, the first lever is the client, not the pipeline** — drop the shipper's
flush alarm from 60s to 30s and the poll's total halves too, for one constant and no new components.

### 12.3 The loop

1. **Wake.** Window = `now − 15min` for a tick, `now − 48h` for a sweep (the EventBridge rule passes `mode`).
2. **Ask CloudWatch what's there.** `FilterLogEvents` over `/orchard/dev/client` for the window — one
   paginated call family for the WHOLE fleet, each event carrying its `logStreamName`. (Not
   `DescribeLogStreams` + per-stream `GetLogEvents`: that loop's cost grows with the fleet; this one doesn't.)
3. **Nothing? Exit.** No GitHub call, no commit, no metric noise. This is the common minute and it must be the
   cheap one.
4. **Flatten.** `JSON.parse` each stored record → `glLine(rec)`; group by `logStreamName` × UTC hour; sort by
   `t`; prepend the `#` header.
5. **Diff.** Read the ref → commit → tree, and compare each candidate body against the blob already there.
   Unchanged files drop out — normally the sweep's entire outcome.
6. **Commit.** Blobs → tree → commit on the current ref, `state/watermark.json` advanced in the same tree, one
   `PATCH` to land it.
7. **Report.** Emit a `Success` metric datum. On failure, throw — Lambda's `Errors` metric plus §12.7's alarms
   carry it; the next tick's lookback covers the gap.

### 12.4 Repo layout

```
logs/2026-07-31/pk_UhpDHsJtxumKAchn5nOuV6/ins_2mke8ceams98gw7p/14.txt
state/watermark.json
README.md
```

- **One file = one stream × one UTC hour.** Date directory and hour filename are both UTC, matching `glLine`'s
  clock (§12.10) — a fleet file never mixes two clocks.
- **Header** (`#` lines, the CW-7 convention): group, stream, the hour's window, the version range seen in it,
  and the export time. So a findings entry can cite a mailbox file exactly like any local trace.
- **`state/watermark.json`:** `{ generatedAt, sweepThrough, streams: { "<stream>": { through, events } } }`.
- **Commit message:** `export 2026-07-31T14:03Z · 2 streams · 47 events` (sweeps say `sweep`). Git history is
  the export audit log — which is also why it is not the payload (§12.9).

### 12.5 Cost and rate envelope

1,440 invocations/day, each a few hundred milliseconds on the idle path — Lambda cost is free-tier-shaped, and
CloudWatch Logs read APIs are not separately metered. The real budget is **GitHub**: a fine-grained PAT gets
5,000 requests/hour, a writing run costs roughly `5 + files` requests, and an idle run costs **zero**. Even a
pathological hour where every single minute writes three files spends ~480/5,000. The sweep is the tail risk —
a 48h rescan is still ONE commit, and its blob count is bounded by files-actually-*changed*, not
files-scanned (ruling 4).

Growth is the honest cost of the `full` ruling. A busy install runs 3–10MB/day (§7), so an hour file is
150–400KB and is rewritten up to 60 times as the hour fills. Git delta-compresses near-identical successive
blobs, so *packed* repo growth tracks the log volume itself (~10MB/day/install) rather than the rewrite count.
One install is ~1GB/quarter; ten installs would be ~9GB/quarter, and §7's per-install 20MB/day quota caps the
pathological case at ~1.8GB/quarter each. That is why rotation is a ruling rather than an option (§5) and why
consumers clone shallow (§12.9). If it ever bites before rotation does, the lever is the same one §7 names:
the level.

### 12.6 Rotation

Quarterly (§5). The exporter's target repo name is configuration, not a constant, so rotation is a config
change plus an archive — see DD-CW-5 for whether that means a new repo per quarter or a truncation in place.
Retention parity is the invariant: **nothing in the mailbox outlives its CloudWatch source by more than a
quarter.**

### 12.7 Failure semantics

| Failure | Behavior |
|---|---|
| Nothing new (the common minute) | exit before touching GitHub — no commit, no noise |
| GitHub 5xx / network | throw; the next tick's lookback covers the gap; ruling 4 makes the retry idempotent |
| GitHub 409 (stale parent) | re-read the ref, rebuild the commit once, then throw |
| Token expired or revoked (401) | every run fails → alarm within minutes. CloudWatch still holds everything; the mailbox simply stops advancing and heals on the next successful run |
| Rate limited (403 + reset) | throw; the tick cadence IS the backoff — a skipped minute costs nothing (ruling 4) |
| Run overruns the tick (a long sweep) | `reservedConcurrency: 1` throttles the overlapping tick away; the next one re-scans a wider window |
| CloudWatch throttling / partial pagination | write what was read, do NOT advance `sweepThrough` |
| Exporter dead entirely | the staleness alarm fires; 90-day CloudWatch retention is the slack — a missed hour is recovered by the next sweep, a missed week by widening it once |

**Alarms** — the first two in the stack, since CW-5's alarm set was never built (its metric filters were):

- `orchard-log-exporter Errors ≥ 5 in 5 minutes` — sustained failure, not a transient 5xx.
- **no `Success` datum for 15 minutes**, `treatMissingData: breaching` — the watching-the-watcher alarm, and
  the only one that catches a silently-not-invoked exporter.

### 12.8 Permissions and the token

- **Lambda role:** `logs:FilterLogEvents`, `logs:GetLogEvents`, `logs:DescribeLogStreams` on
  `/orchard/dev/client` **only**, plus `secretsmanager:GetSecretValue` on `orchard/fleet-logs-github-token`
  **only**. No DynamoDB, no S3, no write to the log group. It cannot mutate anything in the Orchard account.
- **The secret** sits beside `orchard/anthropic-api-key`, same pattern.
- **The token** is a fine-grained PAT scoped to the single mailbox repo with `Contents: read/write` and
  nothing else — it cannot reach `orchard-cloud`, this repo, org settings, or Actions. It **expires**;
  expiry surfaces as the 401 row above, which is why that alarm is part of THIS rung rather than a follow-up.
  (A GitHub App installation token would avoid the expiry at the cost of JWT signing in the Lambda — not
  worth it at fleet-of-one scale, revisit if the mailbox outlives a few rotations.)

### 12.9 The consumer side

`git clone --depth 1` once, `git pull` whenever. Shallow is the default advice deliberately: the payload is
the current state of the files, and a quarter of per-minute commits is audit trail, not data. Reading is just
reading files — "what did install X do yesterday afternoon?" is
`logs/2026-07-30/…/ins_X/13.txt`–`16.txt`. For the findings discipline on THIS machine a ten-line helper
copies a window into `logs/run/orchard-logs-fleet-*.txt` so entries cite it like any trace (the filename
pattern is already what `pull-cloudshell.sh` writes); on a strange machine, work from the clone directly.

### 12.10 CW-8a — the grammar gets one owner

Three implementations of the gl line exist today, and they already disagree:

| Where | Clock | Body |
|---|---|---|
| `studio.js` `formatLogEntryAsText` (the panel download) | **machine-local** (`toLocaleTimeString`) | message + an indented `data` block |
| `logsExport.cjs` `glLine` (CW-7, and CW-8's flattener) | **UTC** | message only |
| `tools/fleet-trace/pull-cloudshell.sh` (jq) | **UTC** | message only |

So CW-7's "byte-compatible with a local panel download" is not true, in two ways. The clock differs by the
machine's UTC offset — cross-referencing a fleet trace against a local one silently misaligns by hours. And
`data` never crosses the wire at all: `normalizeRingEntry` (`Core/logShipping.js`) projects the ring entry to
`{t, lvl, tag, msg, v}`, so the structured payload a local download prints simply does not exist in
CloudWatch or the mailbox. Both are survivable; neither may be *unknown*.

CW-8a: state the divergence in every fleet file's `#` header (UTC, message-only), add a golden-line
conformance test over `glLine`, and rule on whether the panel download grows a UTC mode. This is invariant
family #1's shape one level up — one grammar, N implementations, no test between them.
