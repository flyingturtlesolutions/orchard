@echo off
rem tools/glf/dashboard-tick.cmd — regenerates the glf dashboard, both surfaces (v2.74.2046, glf F6).
rem Fired every 5 minutes by the "orchard-glf-dashboard" scheduled task. Plain node — no claude, ~zero cost.
rem Config lives HERE (in-repo, editable); the task only points at this file. --push delivers the markdown twin
rem to the bus repo (state/dashboard.md), which GitHub renders — the review-from-anywhere surface, whose own
rem age doubles as the remote liveness signal.

cd /d "C:\Users\Divine\Documents\2026_projects\apps\chrome-sidepanel-tester"

rem rotate the output once it passes ~2MB so the append never grows unbounded
for %%A in ("logs\run\dashboard.out") do if exist %%A if %%~zA gtr 2000000 move /y "logs\run\dashboard.out" "logs\run\dashboard.out.1" >nul

node tools\glf\dashboard.cjs --push >> logs\run\dashboard.out 2>&1
