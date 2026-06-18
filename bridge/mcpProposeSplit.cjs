'use strict';
// bridge/mcpProposeSplit.cjs — DBR-P3-3b (docs/DESIGN_dev_branches.md §8.1/U5): a MINIMAL, dependency-free MCP
// stdio server exposing ONE proposal-only tool, `propose_split`, to the spawned `claude -p`.
//
// TRUST (DESIGN §3 — P3-3 sign-off 2026-06-18): this server is INERT. It declares one tool; a `tools/call` returns
// a STATIC acknowledgement and NOTHING ELSE — no fs, no git, no network, no child process, no shared state. Claude
// calling it cannot mutate anything: the PANEL alone seeds the branch, and only on a human tap (devBridge.js
// `_proposeSplitCard` reads the tool_use from the stream → approve/decline card). So exposing it does NOT widen the
// mutation surface — verifiable by reading this whole file. The host wires it via `--mcp-config` (bridge/host.js)
// and allow-lists `mcp__devbridge__propose_split`. Claude's git-free Bash allowlist is unchanged.
//
// .cjs (not .js): the test-harness loader force-loads local `.js` as ESM; `.cjs` stays CommonJS so the host can
// `require()` the inert check AND `bridge/mcpProposeSplit.test.js` default-imports the PURE `handleRpc` (exactly
// how gitOps.cjs is tested). The JSON-RPC dispatch (initialize / tools/list / tools/call) is pure + unit-tested;
// only the stdin/stdout plumbing at the bottom is live-only (the claude↔server handshake).
//
// Transport: MCP stdio = newline-delimited JSON-RPC 2.0 (one JSON object per line), UTF-8, over stdin/stdout.

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'devbridge', version: '1.0.0' };

// The one tool. inputSchema is JSON Schema; `concern` is the only required field (the rest refine the proposal).
const TOOL = {
  name: 'propose_split',
  description:
    'Propose extracting a separable concern into ITS OWN dev branch + conversation. PROPOSAL ONLY — this does NOT '
    + 'create a branch, switch, or run anything; it surfaces a card in the panel where the human approves or '
    + 'declines, and the panel performs the split. Call this when the current task carries work OUTSIDE its stated '
    + 'concern (a foundational/shared change, or an unrelated improvement) instead of doing that work inline. Prefer '
    + 'proposing at PLAN time, before writing the out-of-scope code.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      concern: { type: 'string', description: 'The separable concern to split out — a short imperative phrase (e.g. "extract the date formatter into Core").' },
      reason: { type: 'string', description: 'One sentence: why it belongs on its own branch.' },
      branchBase: { type: 'string', description: "Base branch: 'main' (default) or a 'dev/…' branch ONLY if the split genuinely depends on the parent's uncommitted work." },
      seedPrompt: { type: 'string', description: 'The first prompt to seed the new conversation with — what to do on that branch.' },
      suggestedName: { type: 'string', description: 'Optional short name for the branch slug.' },
    },
    required: ['concern'],
  },
};

const ACK =
  'Proposal surfaced to the user in the panel — they will approve or decline it there. Do NOT do the split-out work '
  + 'inline; continue with the in-scope task.';

const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// handleRpc — the PURE dispatcher: one parsed JSON-RPC message → a response object, or null for a notification
// (no `id`) or anything that needs no reply. No I/O. (`id` may legitimately be 0 — treat only undefined/null as a
// notification.) Unit-tested in bridge/mcpProposeSplit.test.js.
function handleRpc(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const { id, method } = msg;
  const isNotification = id === undefined || id === null;
  switch (method) {
    case 'initialize':
      return rpcOk(id, {
        protocolVersion: (msg.params && typeof msg.params.protocolVersion === 'string') ? msg.params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'notifications/initialized':
    case 'initialized':
      return null;                                   // notification — no reply
    case 'ping':
      return isNotification ? null : rpcOk(id, {});
    case 'tools/list':
      return rpcOk(id, { tools: [TOOL] });
    case 'tools/call': {
      const name = msg.params && msg.params.name;
      if (name !== 'propose_split') return rpcErr(id, -32602, `Unknown tool: ${name}`);
      // INERT: acknowledge only. The panel reads the tool_use from the stream and does the (human-gated) work.
      return rpcOk(id, { content: [{ type: 'text', text: ACK }], isError: false });
    }
    default:
      return isNotification ? null : rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

module.exports = { PROTOCOL_VERSION, SERVER_INFO, TOOL, ACK, handleRpc };

// ── stdio runner (live only; not exercised by the unit test) ──
if (require.main === module) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { continue; }   // ignore an unparseable line
      let res = null;
      try { res = handleRpc(msg); } catch { res = (msg && msg.id != null) ? rpcErr(msg.id, -32603, 'Internal error') : null; }
      if (res) { try { process.stdout.write(JSON.stringify(res) + '\n'); } catch { /* */ } }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
