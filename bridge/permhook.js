#!/usr/bin/env node
'use strict';
// bridge/permhook.js — DB-3 permission relay client (v2.74.1002). Claude runs this as a PreToolUse hook
// (broad matcher) BEFORE every tool. The safe tier auto-allows; everything else is RELAYED to the panel
// (a file request the host forwards) and this process BLOCKS for the user's Allow/Deny click. A timeout
// denies (fail-SAFE — the opposite of --permission-prompt-tool's fail-open, see DESIGN §6).
//
// Hook I/O contract (verified by bridge/hooktest.cjs): stdin = JSON { tool_name, tool_input, ... };
// stdout = { hookSpecificOutput: { hookEventName:'PreToolUse', permissionDecision:'allow'|'deny', ... } }.
const fs = require('fs');
const path = require('path');
const PERM_DIR = path.resolve(__dirname, '..', 'logs', 'bridge', 'perm');
const TIMEOUT_MS = 120000;   // a closed panel must not hang claude forever → deny after 2 min
const POLL_MS = 200;

// Safe tier = the DB-1/DB-2 allowlist (repo reads/edits + scoped test runs). Everything else is relayed.
const AUTO_ALLOW = new Set(['Read', 'Grep', 'Glob', 'LS', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite', 'Task']);
function isSafe(tool, input) {
  if (AUTO_ALLOW.has(tool)) return true;
  if (tool === 'Bash') {
    const c = String((input && input.command) || '').trim();
    // Never auto-allow a chained/redirected command — a metachar could smuggle a dangerous call past the
    // prefix check (`node --version; git push`). Any shell metacharacter → relay (let the user decide).
    if (/[;&|`$><\n]/.test(c)) return false;
    return /^(npm test|node )/.test(c);
  }
  return false;
}
function out(decision, reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason || '' } }));
  process.exit(0);
}

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let req = {};
  try { req = JSON.parse(input); } catch { /* */ }
  const tool = req.tool_name || '?';
  const toolInput = req.tool_input || {};
  if (isSafe(tool, toolInput)) out('allow', 'auto (safe tier)');

  // ---- relay: write a request, then block polling for the host-written response ----
  try { fs.mkdirSync(PERM_DIR, { recursive: true }); } catch { /* */ }
  const id = `${Date.now()}_${process.pid}`;
  const reqFile = path.join(PERM_DIR, `${id}.req.json`);
  const respFile = path.join(PERM_DIR, `${id}.resp.json`);
  try { fs.writeFileSync(reqFile, JSON.stringify({ id, tool_name: tool, tool_input: toolInput, ts: Date.now() })); }
  catch { out('deny', 'relay write failed'); }

  const start = Date.now();
  const timer = setInterval(() => {
    let resp = null;
    try { resp = JSON.parse(fs.readFileSync(respFile, 'utf8')); } catch { /* not yet */ }
    if (resp) {
      clearInterval(timer);
      try { fs.unlinkSync(reqFile); } catch { /* */ }
      try { fs.unlinkSync(respFile); } catch { /* */ }
      out(resp.decision === 'allow' ? 'allow' : 'deny', resp.reason || 'panel decision');
    } else if (Date.now() - start > TIMEOUT_MS) {
      clearInterval(timer);
      try { fs.unlinkSync(reqFile); } catch { /* */ }
      out('deny', 'approval timed out (no panel response)');
    }
  }, POLL_MS);
});
