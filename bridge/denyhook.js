#!/usr/bin/env node
'use strict';
// PreToolUse hook spike: deny the tool and log that we ran. Reads the hook JSON on stdin, emits a
// PreToolUse permission decision on stdout. (The real relay would forward to the host→panel and block
// for the user's click instead of hard-denying.)
const fs = require('fs');
const path = require('path');
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let tool = '?';
  try { tool = (JSON.parse(input).tool_name) || '?'; } catch { /* */ }
  try { fs.appendFileSync(path.resolve(__dirname, '..', 'logs', 'bridge', '_hook.log'), `${new Date().toISOString()} PreToolUse tool=${tool}\n`); } catch { /* */ }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'blocked by dev-bridge hook (spike)' },
  }));
  process.exit(0);
});
