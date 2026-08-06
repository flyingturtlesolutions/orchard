@echo off
rem tools/glf/headless-tick.cmd — the durable auto-glf grader, grade-only variant (v2.74.2044, glf F5).
rem Fired every 5 minutes by the "orchard-auto-glf" scheduled task. ALL config lives in this file (in-repo,
rem editable, versioned); the task only points here — the same point-at-the-file principle as the session cron.
rem Grade-only enforcement is two-layer: the HEADLESS_PROMPT constraints (discipline) + the --allowedTools list
rem below (mechanism): git mutation is only reachable through the `git -C ../orchard-logs` prefix forms, so the
rem extension repo cannot be committed/pushed by this session even if the prompt is misread. Writes are scoped to
rem logs/run/ (evidence + copied windows). Full-rights variant = widen the list; that is the user's call.
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

"C:\Users\Divine\.local\bin\claude.exe" -p "Read tools/glf/HEADLESS_PROMPT.md in full and follow it exactly." --permission-mode default --add-dir "C:\Users\Divine\Documents\2026_projects\apps\orchard-logs" --allowedTools "Read,Grep,Glob,Bash(node *),Bash(git -C ../orchard-logs *),Bash(git -C C:/Users/Divine/Documents/2026_projects/apps/orchard-logs *),Bash(git -C C:\Users\Divine\Documents\2026_projects\apps\orchard-logs *),Bash(git status*),Bash(git log*),Bash(git diff*),Bash(git show*),Bash(git rev-parse*),Edit(logs/run/**)" >> logs\run\cron.out 2>&1
