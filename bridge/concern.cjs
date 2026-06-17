// bridge/concern.cjs — DBR-5 (v2.74.1037, DESIGN §8.2): the per-spawn scope-contract builder. PURE, no deps;
// required by bridge/host.js and unit-tested by bridge/concern.test.js (the `npm test` glob includes
// bridge/*.test.js). The host re-passes the returned contract via `--append-system-prompt` on EVERY
// `claude -p` spawn (initial AND every `--resume`) — the system prompt is reconstructed per-invocation, so
// the guardrail would silently lapse after turn 1 if it weren't re-injected. Built fresh each spawn from the
// conversation's stored `concern` (defaults to the first ask; user-editable — DESIGN §8.2).
//
// INJECTION BOUNDARY. The concern is USER-DERIVED, so it reaches the command line ONLY as a sanitized,
// DISCRETE argv element (host.js passes claude's args as separate array elements to cmd.exe, never as one
// concatenated string — verified: a quoted multi-word value in a single command string gets split on spaces
// with literal backslash-quote fragments, the `.988` --allowedTools mangling; discrete elements survive
// intact). Two extra guards keep that element inert: (1) strip the only chars cmd.exe still expands inside
// double quotes (percent) or that would break Node's quoting (double-quote), plus control chars; (2) force a
// SINGLE line — an embedded newline can terminate a cmd.exe command line even inside quotes. The result is
// words + safe punctuation on one line: safe as a discrete argv element. (CLAUDE.md's rule is "validated
// before reaching the command line" — this is that validation, declared per "don't widen the trust surface".)
'use strict';

const MAX_LEN = 280;   // a concern is a one-line LABEL; cap so a giant first-ask can't bloat the system prompt
const STRIP_RE = new RegExp('[%"\\x00-\\x1F\\x7F]', 'g');   // cmd-special + quote-breaking + control chars

// Sanitize a concern to a safe single-line label, then collapse all whitespace to single spaces. PURE.
function _safeLabel(concern) {
  return String(concern == null ? '' : concern)
    .replace(STRIP_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build the scope contract from a concern, or return null when there's no concern (→ the host adds no flag,
// so a concern-less run behaves exactly as before). Single line by construction (see INJECTION BOUNDARY).
// Phase 1: the contract tells Claude to STOP and tell the user (the `propose_split` tool is Phase 3 — §8.1).
function buildConcernContract(concern) {
  const c = _safeLabel(concern);
  if (!c) return null;
  const label = c.length > MAX_LEN ? c.slice(0, MAX_LEN).replace(/\s+\S*$/, '').trim() + '…' : c;
  return `You are working ONLY on: ${label}. `
    + "Don't refactor unrelated or shared code. If a fix needs shared or foundational files, STOP and tell the user instead of doing it inline.";
}

module.exports = { buildConcernContract, _safeLabel, MAX_LEN };
