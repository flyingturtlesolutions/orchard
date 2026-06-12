# DESIGN — Dev Bridge (Claude Code in the side panel, behind a native host)

> Status: **proposed** · Author: design discussion 2026-06-12 (working tree v2.74.964) · Sibling of
> `DESIGN_llm_front_door.md` (the router) and `DESIGN_injection_boundary.md` (the trust rules this doc
> must not weaken). Scope: **local dev tooling** — not the routing path, not the future agentic
> capability-authoring tier.

## 1. Problem

The dev loop today is manual and split across surfaces: live test in the extension → Studio "Decisions"
download → file lands in `Downloads/` → switch to a terminal → type `gl` (move + analyze + findings entry)
→ fix lands → switch back → reload the extension → retest. Each iteration costs minutes of context
switching, and the trace handoff (Downloads → `logs/run/`) is a copy step a machine should do.

Meanwhile the assistant on the other end of that terminal already carries the whole project protocol:
CLAUDE.md, auto-memory (`gl`/`cp`/`bcp` semantics, versioning rules), the `build-log.cjs` Stop hook, the
findings ledger conventions. The bridge's job is **not** to build a second assistant — it is to give the
existing one a second front door, inside the side panel, with the same conventions intact.

## 2. Verdict — proven shape, one novel hop

Claude Code's IDE integrations (VS Code / JetBrains) are exactly this architecture: an embedding UI spawns
the CLI as a subprocess and streams its events. `-p --output-format stream-json` is the supported contract
for programmatic consumption. The only novel pieces here are (a) the **native-messaging hop** (an MV3
side panel cannot spawn processes) and (b) **self-reload** (the fix being applied restarts the surface
watching the fix). Both are solved by the same load-bearing decision: §3.3's detached-spawn + journal.

What this bridge is NOT (non-goals, binding):
- **Not the router.** Warm/cold ask routing stays the R-arc cascade (`DESIGN_llm_front_door.md` §3.2).
  The bridge is unreachable from the ask pipeline — different code path, different trust domain.
- **Not the agentic escalation tier.** Capability authoring by an agent (gap → bounded agent attempt →
  trial gate) is a future arc with its own doc; it runs against the substrate, not the repo.
- **Not autonomous.** Every bridge run is user-initiated in the panel. No auto-trigger on failures.
- **Not a committer.** Bridge runs never `git commit`/`push` — `cp`/`bcp` remain human-typed in a
  terminal, and the pre-commit diff review is the final safety net.

## 3. Target architecture

```
┌─ side panel (chat page) ─┐   port    ┌─ native host (Node ≥18) ─┐  spawn(detached)  ┌─ claude -p ─┐
│ dev mode UI              │◄────────►│ com.orchard.devbridge     │─────────────────►│ cwd = repo   │
│ verbs: gl / bug: / dev:  │ runtime. │ • framing + schema guard  │   journal tail    │ stream-json  │
│ stream renderer, HITL    │ connect  │ • write trace → logs/run/ │◄─────────────────│ → journal    │
└──────────────────────────┘  Native  │ • spawn/cancel/reattach   │                   └──────────────┘
                                      └───────────────────────────┘
```

### 3.1 Transport: native messaging (not a localhost daemon)

| | native messaging | localhost daemon |
|---|---|---|
| lifecycle | Chrome-managed, on-demand | manual start, ports, conflicts |
| reachable by | this extension only (`allowed_origins`) | any local process/page (needs auth token) |
| attack surface | stdio, no open port | open port |
| dev friction | one-time registry key | none, but recurring daemon babysitting |

Native messaging wins on every axis that matters long-term. Mechanics (Windows):
- Host manifest JSON `{name:"com.orchard.devbridge", path:<.bat wrapper>, type:"stdio", allowed_origins:["chrome-extension://<ID>/"]}`.
  Windows requires `path` to be an `.exe`/`.bat` — a 2-line `.bat` invoking `node host.js`.
- Registry: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.orchard.devbridge` → manifest path. HKCU
  = no admin. An idempotent `install.ps1`/`.cmd` ships in the repo (`bridge/` folder, host + installer).
- **Prerequisite:** pin the extension ID by adding a `"key"` field to manifest.json (an unpacked ID is
  path-derived; `key` freezes it so `allowed_origins` can hard-code it).
- Framing: 4-byte length + JSON, both directions. Host→Chrome messages are capped at 1 MB — stream events
  are small, so this only constrains attachments, which flow Chrome→host (4 GB cap; we self-cap at 2 MB).
- **Connect from the side panel document, not the service worker.** The panel is a real page; the port
  lives while the panel is open. No MV3 SW-lifetime games on the UI side.

### 3.2 The runner: shell the CLI, don't embed the SDK

The host spawns `claude -p "<prompt>" --output-format stream-json --verbose --max-turns <N>` with
`cwd` = the repo root. Shelling the CLI (vs. the Agent SDK's `query()`) is deliberate:
- **Behavioral parity with the daily driver.** CLAUDE.md, `~/.claude` project memory, hooks (the
  `build-log.cjs` Stop hook auto-appends bridge runs to `logs/build/` like every terminal session),
  settings, skills — all load identically. The bridge invokes *the same assistant*.
- **Session continuity both ways.** The `init` event yields a `session_id`; the panel shows a
  "continue in terminal: `claude --resume <id>`" handoff. A gnarly in-panel session escalates to a full
  terminal with context intact. Nothing is trapped in the panel.
- Events consumed: `system/init` (session_id, model), `assistant` messages (text + `tool_use` blocks →
  tool chips), `result` (subtype, `total_cost_usd`, `duration_ms`, `num_turns`, final text).

### 3.3 Detached spawn + journal (the load-bearing decision)

Two kill paths threaten an in-flight run: Chrome terminates the host when the port closes (panel closed),
and `chrome.runtime.reload()` after an applied fix severs the port by design. Therefore:
- The host spawns `claude` **detached** (`detached:true`, stdio → journal file, `unref()`), then exits
  freely when its port dies. The run survives both kill paths.
- **Journal:** `logs/bridge/<ts>.jsonl` (git-ignored, same convention as the other log streams) — the raw
  stream-json events. A meta file `logs/bridge/active.json` records `{pid, sessionId, journalPath,
  startedAt}`.
- **Reattach:** a new host instance (panel reopened / extension reloaded) reads `active.json`, probes the
  pid, tails the journal from offset 0, and the panel replays/catches up. Completion = `result` event in
  the journal (or pid death without one → reported as `host-lost`).
- **Lockfile = active.json.** One bridge run at a time; a stale lock (dead pid) is reclaimed. NB this only
  serializes bridge-vs-bridge — a concurrent *terminal* session editing the same repo remains human
  discipline, exactly as two terminals are today.

### 3.4 Port protocol (extension ↔ host)

Panel → host: `{type:'run', verb:'gl'|'bug'|'dev', text?, attachments?:[{kind:'decisions-trace',
filename, content}], maxTurns?}` · `{type:'cancel'}` · `{type:'status'}` (triggers reattach/replay) ·
`{type:'diffstat'}`.
Host → panel: `{type:'preflight', ok, claudeVersion?, nodeVersion?, error?}` · `{type:'event', ev}` (one
stream-json event, verbatim) · `{type:'done', result}` · `{type:'diffstat', files:[{path, plus, minus}]}` ·
`{type:'error', code, message}`.
The host validates every inbound message against this schema, rejects unknown types/fields, caps
attachment size, and **writes only under `logs/`** (trace attachments → `logs/run/`, journals →
`logs/bridge/`). It never executes panel-supplied shell strings; the only thing it spawns is `claude`
with host-assembled args.

## 4. Verbs + prompt composition

The prompt is composed ONLY from user-typed text plus extension-generated artifacts. Three verbs:

| verb | composition | notes |
|---|---|---|
| `gl` | host writes the panel-supplied decisions trace to `logs/run/orchard-logs-decisions-<ts>.txt`, prompt = literal `"gl"` | filename matches the existing pattern so newest-file selection + all gl memory conventions just work; the Downloads round-trip disappears (the panel already holds the trace text the Studio button serializes) |
| `bug: <text>` | user text + auto-attached newest trace + manifest version line | the "something broke, here's what I saw" path |
| `dev: <text>` | verbatim passthrough | anything else; `dev: cp` will simply fail (git is not in the allowlist — commits stay in the terminal) |

The composed prompt is shown to the user before send (one-line summary + attachment names). Send is a
click; nothing auto-sends.

## 5. Trust & injection boundary

The bridge adds a **repo-write-capable agent** adjacent to a surface that processes untrusted page
content. The rules that keep `DESIGN_injection_boundary.md` intact:

1. **Page content cannot compose, trigger, or auto-send a bridge prompt.** The dev surface is a separate
   code path from the ask pipeline, gated behind a dev-mode toggle, visually distinct (different chrome —
   it is a different trust domain), and only ever activated by a user click/typed verb.
2. **Traces are data.** Page-derived strings ride inside traces (already PII-scrubbed by Logger). The
   receiving session treats trace content as data to analyze — and the backstop is structural, not
   behavioral: bridge runs cannot commit (no git in the allowlist), so a poisoned-trace-induced bad edit
   dies in the human diff review before `cp`/`bcp`.
3. **Origin lock.** `allowed_origins` pins the host to this extension's (key-pinned) ID. No other
   extension, page, or process can drive it.
4. **No credentials in the extension.** The CLI authenticates host-side (its own login/keychain). The
   extension never sees or stores a key.
5. **Reload is gated.** `Apply & Reload` renders only after a `result` event with repo changes
   (host-reported diffstat shown first), never mid-run.

## 6. Permission model (per-slice tightening)

Headless `-p` cannot answer permission prompts, so each slice declares its policy via `--allowedTools`:

- **DB-1 (analyze):** `Read, Grep, Glob, Edit, Write` — no Bash. Enough for gl (read logs, append the
  findings entry); the danger tier is arbitrary shell, not tracked-file edits sitting in a git tree.
- **DB-2 (fix loop):** + `Bash(npm test:*)`, `Bash(node:*)` (syntax checks + suite). Still no git, no
  network tools.
- **DB-3 (HITL relay):** replace the blanket allowlist with `--permission-prompt-tool` → an MCP tool the
  host serves → permission requests stream to the panel → the user approves/denies inline, exactly like
  the terminal. The panel becomes the permission UI; unusual tool calls stop being pre-authorized.

## 7. Panel UX

- **Dev mode** toggle in settings reveals the dev tab/verb. Distinct styling (trust domain marker).
- **Stream rendering:** assistant text as it arrives; `tool_use` blocks as compact chips
  ("✎ Core/postcondition.js", "▶ npm test → 800 passing"); `result` footer with cost + duration +
  turn count — every run shows what it cost.
- **Controls:** `Cancel` (host kills the process tree) · `Apply & Reload` (post-result, diffstat first,
  disabled while a run is active) · "continue in terminal" hint (`claude --resume <id>`).
- **Preflight surface:** port-open failure → install instructions (run `bridge/install.ps1`); version
  failures → actionable message (`claude --version`, Node ≥18 — NB the repo's test harness pins Node
  16.15.1, but the host runs on its own newer runtime; the installer checks).

## 8. Failure modes

| failure | behavior |
|---|---|
| host not installed / registry missing | port error → panel shows install card |
| `claude` not on PATH / too old for stream-json | preflight error with the exact command to run |
| panel closed mid-run | run continues detached; reopen → `status` → reattach + replay journal |
| extension reloaded mid-run | same as above (this is why §3.3 exists); `Apply & Reload` is gated to post-result anyway |
| host crash | pid probe on `active.json` → `host-lost` + journal tail still readable |
| second `run` while one active | refused with the active run's id (lockfile) |
| runaway run | `--max-turns` cap + Cancel; cost visible live in the footer |
| concurrent terminal session editing the repo | out of scope (human discipline, same as two terminals today) |

## 9. Slices

- **DB-1 — "gl in the panel" (read/analyze).** `bridge/` host + installer + `"key"` pin; panel port
  client + dev tab + stream renderer; verbs `gl` and `dev:`; DB-1 allowlist. *Acceptance:* after a live
  run, one click in the panel → trace lands in `logs/run/`, analysis streams into the panel, the run
  itself appends the findings entry — zero terminal, zero Downloads.
- **DB-2 — fix loop.** `bug:` verb; DB-2 allowlist; post-run diffstat; `Apply & Reload` with gating.
  *Acceptance:* report a bug in the panel → streamed fix → suite green in-stream → diffstat → reload →
  retest, terminal untouched; commit still happens later via terminal `bcp`.
- **DB-3 — lifecycle + HITL.** Journal reattach, Cancel, cost footer polish, `--resume` terminal handoff,
  permission relay replacing the blanket allowlist, run history (last N journals) in the panel.

Effort: host ~200 lines + installer ~50; extension side ~250–300 (port client, dev UI, renderer). DB-1 is
one to two focused sessions; DB-2 mostly flags + gating; DB-3 carries the real new design (relay MCP).

## 10. Open questions

1. **Auto-version-bump on bridge fixes** — inherited for free (same assistant, same memory convention);
   confirm the first DB-2 run actually does it.
2. **Panel transcript persistence** — v1 ephemeral (journal on disk is the record); fold into
   ConversationStore later if dev sessions deserve history in-UI.
3. **Multi-repo** — out of scope; host config carries one `cwd`. Revisit if the cloud (C-P3) side ever
   wants a bridge.
4. **The escalation-tier interplay** — once DB-3's permission relay exists, the same host+relay pattern is
   reusable by the future capability-authoring agent doc; keep the relay generic enough to share.
