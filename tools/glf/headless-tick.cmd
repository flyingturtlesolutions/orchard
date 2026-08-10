@echo off
rem tools/glf/headless-tick.cmd — the durable auto-glf grader, grade-only variant (v2.74.2044, glf F5).
rem Fired every 5 minutes by the "orchard-auto-glf" scheduled task. ALL config lives in this file (in-repo,
rem editable, versioned); the task only points here — the same point-at-the-file principle as the session cron.
rem Grade-only enforcement is two-layer: the HEADLESS_PROMPT constraints (discipline) + the --allowedTools list
rem below (mechanism): git mutation is only reachable through the `git -C ../orchard-logs` prefix forms, so the
rem extension repo cannot be committed/pushed by this session even if the prompt is misread. Writes are scoped to
rem logs/run/ (evidence + copied windows). Full-rights variant = widen the list; that is the user's call.
rem
rem v2.74.2104 — EVIDENCE BANKING. CRON_PROMPT STEP 1 requires any cited window to be copied into logs/run/ in
rem the same tick (the fleet archive is a ~48h ring that rewrites in place). The grade-only session could not do
rem it, and it took THREE attempts to get right. The record, because each wrong turn was a plausible theory:
rem
rem   1st (12:5x) — added `Write(logs/run/**)`, on the theory that `Edit(logs/run/**)` alone failed because the
rem                 Edit TOOL cannot create a file. True about the tool, IRRELEVANT to the permission layer.
rem   2nd (16:30) — grader reported Write still denied twice; added absolute-path forms of Write, on the theory
rem                 that Write/Edit take absolute paths so a relative glob cannot match. Right about paths.
rem   3rd (16:35) — the ANSWER, printed by the tool itself in cron.out and read only when someone looked:
rem                 "Permission allow rule (--allowed-tools): Write(logs/run/**) is not matched by file
rem                  permission checks — only Edit(path) rules are. Use Edit(logs/run/**) instead (Edit rules
rem                  cover all file-editing tools)."
rem
rem So: `Write(...)` is NOT a valid permission form — an `Edit(path)` rule covers every file-editing tool,
rem Write included. The residual real bug was the PATH FORM: the agent passes an absolute path, and the original
rem `Edit(logs/run/**)` is relative, so it never matched. Final list = Edit only, in relative +
rem forward-slash-absolute + backslash-absolute forms (the same three-form enumeration every `git -C` entry
rem above already uses — that precedent was the tell, and it was sitting in this file the whole time).
rem
rem LESSON: the tool PRINTED the fix into cron.out at the first failure. Two rounds of theorising cost more than
rem reading the log the loop exists to read. Grant stays file-editing confined to logs/run/ — no directory
rem reach, no git mutation, extension repo still structurally un-committable from this session.
rem
rem --permission-mode default IS the mechanism (adversarial verify, 2026-08-06): the user-level settings default
rem to bypassPermissions, under which an --allowedTools list is INERT (empirically proven — a non-allowlisted
rem command executed). Pinning default mode here makes the allowlist load-bearing; a denied tool in -p mode
rem aborts the firing, which is the correct failure for an unattended session. Same pattern as the dev-bridge.
rem --add-dir grants READ reach into the bus repo (allowedTools alone never widens the directory boundary).

cd /d "C:\Users\Divine\Documents\2026_projects\apps\chrome-sidepanel-tester"

rem rotate the output once it passes ~5MB so the append never grows unbounded
for %%A in ("logs\run\cron.out") do if exist %%A if %%~zA gtr 5000000 move /y "logs\run\cron.out" "logs\run\cron.out.1" >nul

echo ===== orchard-auto-glf firing %date% %time% ===== >> logs\run\cron.out

rem ── THE FREE GATE (v2.74.2146) ───────────────────────────────────────────────────────────────────────────────
rem Measured 2026-08-10 over the last 10 firings: ~30 API calls and ~1.65M tokens EACH (97% cache-read), x285
rem firings/day = ~469M tokens/day, all on Opus. Almost none of it bought a verdict: that day's fleet logs held
rem 2,022 SyncEngine + 51 VITALS + 43 CloudClient + 34 SGV lines and ZERO CHAT/BRANCH/PIPELINE/TARGET lines, so
rem every firing re-derived the same result from the same heartbeat.
rem
rem precheck.cjs decides for free (local fs + git, no network, no tokens) whether anything a verdict DEPENDS on
rem moved: the build fingerprint, the count of non-heartbeat fleet lines, or the bus's tests/results. Exit 0 =
rem pay for the grader, exit 1 = skip. It fails OPEN everywhere — unknown line shapes count as signal, any error
rem returns RUN, and --max-skips forces a run every 12 firings (~1h) so a wrong gate cannot go quiet unnoticed
rem and cron.out keeps a proof-of-life line. Raise --max-skips to blink less; lower it to be more paranoid.
rem NOTE the single-line `if` with no label and no goto. This file is LF-only (it always has been) and cmd.exe
rem seeks labels by byte offset, so `goto :eof` / `:skipped` in an LF batch mis-parses mid-line — the first
rem attempt at this gate died with "'es' is not recognized" and "+ was unexpected at this time". The linear form
rem below is what an LF batch executes reliably; do not reintroduce labels without converting the file to CRLF.
node tools\glf\precheck.cjs --max-skips 12 >> logs\run\cron.out 2>&1

rem --model: the loop is a sweep, not a research task — the owner's call (2026-08-10), "no reason to use opus for
rem a simple loop". Grading judgment is the thing being traded; if verdict quality drops (a PASS that should have
rem been INCONCLUSIVE, a missed FAIL arm), this one flag is the revert.
if not errorlevel 1 "C:\Users\Divine\.local\bin\claude.exe" -p "Read tools/glf/HEADLESS_PROMPT.md in full and follow it exactly." --model sonnet --permission-mode default --add-dir "C:\Users\Divine\Documents\2026_projects\apps\orchard-logs" --allowedTools "Read,Grep,Glob,Bash(node *),Bash(git -C ../orchard-logs *),Bash(git -C C:/Users/Divine/Documents/2026_projects/apps/orchard-logs *),Bash(git -C C:\Users\Divine\Documents\2026_projects\apps\orchard-logs *),Bash(git status*),Bash(git log*),Bash(git diff*),Bash(git show*),Bash(git rev-parse*),Edit(logs/run/**),Edit(C:/Users/Divine/Documents/2026_projects/apps/chrome-sidepanel-tester/logs/run/**),Edit(C:\Users\Divine\Documents\2026_projects\apps\chrome-sidepanel-tester\logs\run\**)" >> logs\run\cron.out 2>&1

