# Dev-bridge example workflows

Multi-paragraph task briefs to paste into the side-panel dev bridge (enable with `dev: on`).
Each is a real, scoped piece of the remaining dev-bridge work (see `DESIGN_dev_bridge.md` §9 / §11),
written the way you'd brief a teammate — context, the ask, the constraints, the acceptance bar.

They also serve as rendering fixtures: each produces long, multi-paragraph streamed output (prose +
tool chips + a result footer), which exercises the v2.74.987–.995 panel work — markdown blocks,
collapse, the working…/Pause footer, and the follow-scroll that anchors to it.

Tips: prefix with `dev:` for a fresh thread or `dev: new …` to force one; a plain follow-up `dev: …`
continues the same session. Use `dev: pause` to stop and `dev: <redirect>` to resume with a steer.
Set the budget first if a task is large, e.g. `dev: turns 60`.

---

## 1 — DB-3 journal reattach (`dev: new …`)

```
We need the dev bridge to survive a panel close or extension reload while a run is in flight.
Today the host already journals every run to logs/bridge/<ts>.jsonl and tracks the child pid in
logs/bridge/active.json, and it answers a `status` verb — but the PANEL never asks for status on
reconnect, so a reopened panel shows nothing and the run looks lost even when it is still going.

Implement panel-side reattach. On dev-bridge startup (and whenever the port reconnects), have the
panel send `{type:'status'}`. If the host reports an active run, recreate a run bubble, then have the
host re-tail that run's journal from offset 0 and stream the events through the normal `event`/`done`
path so the panel replays the run and catches up live. A run that already finished (a `result` line is
present, or the pid is dead with no result) should render its terminal state rather than a live footer.

Keep the existing trust rules intact: no new permissions, the host still writes only under logs/, and
the protocol stays versioned {v:1}. Do not touch the spawn path beyond what reattach needs. When you
are done, run `npm test` and confirm it is still green, and summarise exactly which kill paths
(panel-close vs extension-reload vs host-crash) are now covered and which remain best-effort on Windows.
```

## 2 — DB-3 run history (`dev: new …`)

```
Add a "recent runs" view to the dev bridge so I can look back at what a past run did without re-running
it. The host already leaves one journal per run in logs/bridge/<ts>.jsonl plus a sibling <ts>.err.log;
that is the source of truth — do not invent a new store.

Host side: add a `history` verb that returns the last N journals as lightweight summaries — timestamp,
verb, model, turn/cost/duration if the journal has a result line, and a one-line prompt preview — newest
first, capped at ~20, cheap to compute (stat + a small head read, never the whole file). Add a
`history-open` verb that streams a single journal back so the panel can replay it read-only.

Panel side: render the list as a compact, collapsible section in the dev surface (reuse the existing
collapse + block rendering — do NOT build a second renderer). Clicking an entry replays that journal
into a bubble using the same block path as a live run, but with no footer and no Pause (it is history).

Stay within the current allowlist and trust rules; this is all read-only over logs/. Run the suite when
done and tell me where you capped the list and why, plus anything you deliberately left out of scope.
```

## 3 — Tighten the bug-report prompt (`dev: new …`)

```
The `bug:` verb composes its prompt in bridge/host.js (the `bug` branch of startRun): user report +
a pointer to the freshly written decisions trace + a version line, then a request for a verified fix.
It works, but the guidance is thin. I want the composed prompt to steer the run the way our findings
loop actually works, without putting any user text on the command line (the prompt must stay STDIN-fed).

Rework the composed bug prompt so it tells the run to: read logs/run/findings.md first for prior context
on the same symptom; reproduce or locate the failure from the attached decisions trace before editing;
make the smallest fix that addresses the cause, not the symptom; bump manifest.json per the versioning
rule; append a findings.md entry (symptom → cause → change); and verify with `npm test` before
finishing — never committing, since the human runs cp/bcp after a diff review.

Keep it a single host-built literal with the user's report and the version interpolated as DATA only.
Then show me the exact final prompt string for a sample report, and run the suite to confirm green.
```

## 4 — Render-path audit (`dev: new …`)

```
Audit the dev-bridge panel rendering for correctness and safety, end to end, and report findings before
changing anything. The relevant code is Services/Chat/devBridge.js (block model, _emit, _blocksToMarkdown,
the follow-scroll), chat.js (_decorateDevBubble, the rehydrate branch, _setMessageBody), and the
.dev-blk / .dev-* rules in assets/chat.css.

Focus on three questions. First, injection: every path that renders host-streamed or page-derived text
must reach the screen either as textContent or through renderMarkdown (which HTML-escapes first) — find
any path that sets innerHTML on un-escaped content. Second, persistence fidelity: a run rendered live,
then reloaded from ConversationStore, should look equivalent (markdown prose, code blocks) — note where
it legitimately degrades (tool chips → inline code) versus where it is an actual bug. Third, the
follow-scroll: confirm a large single block can never silently stop following, and that scrolling up
detaches and scrolling back re-attaches.

Produce a findings list (file:line, symptom, severity) and a recommended fix for each — but do not edit
yet; I will pick which to apply. Read-only tools plus npm test are enough for this pass.
```
