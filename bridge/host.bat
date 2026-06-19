@echo off
rem bridge/host.bat - DB-1: Windows native-messaging hosts must point at an .exe/.bat (spec 3.1).
rem DBR-P4 (§10) — ORCHARD_MAX_CONCURRENT>1 flips the host to worktree mode: that many `claude -p` runs at once,
rem each in its own .wt/<branch> worktree. MUST be set BEFORE the (single) node call so the child inherits it.
set "ORCHARD_MAX_CONCURRENT=3"
node "%~dp0host.js" %*
