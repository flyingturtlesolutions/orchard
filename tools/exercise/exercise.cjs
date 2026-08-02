#!/usr/bin/env node
// tools/exercise/exercise.cjs — EX-2 (v2.74.1949): THE LOOP'S HAND ON THE BROWSER.
//
// EX-1 (v1946) gave the extension DEV_RELOAD_EXTENSION and DEV_RUN_ASK, and then nothing could call them: they
// fire on chrome.runtime.sendMessage, which only an extension context can send. The handlers sat live and
// unreachable for four ticks — built-but-unnameable, in my own work. This is the missing caller.
//
// It drives Chrome's remote-debugging protocol: attach to the Orchard side panel's target, evaluate exactly one
// chrome.runtime.sendMessage there, done. The panel is the right context because the message then travels the
// REAL path (panel → SW handler → panel listener → sendChatMessage), so an exercised ask is indistinguishable
// from a typed one — which is the entire point of testing through the front door.
//
// WHY IT LIVES IN tools/ AND NOT IN THE EXTENSION: same line tools/progress-digest draws. The digest holds
// `git push` precisely so the shipped extension never has to. A remote-drive channel built INTO the extension
// would have to be trusted on every install, forever, to solve a problem that exists on one machine during a
// build loop. The capability belongs to the dev harness. (CLAUDE.md, "Trust rules for the dev-bridge".)
//
// DELIBERATE NON-FEATURES:
//   · No --eval. Two verbs only. The moment this accepts arbitrary expressions it stops being an exerciser and
//     becomes "run any JS in Divine's logged-in browser", and it will be used that way.
//   · No target selection by name/index. Only targets under the Orchard extension id (derived from manifest.key,
//     so it cannot drift) are ever touched. A typo must not evaluate script in a banking tab.
//   · No write protection here, because it already exists where it belongs: both write belts refuse a non-GET
//     write without confirmed:true, so an exercised ask that routes to a write leg is BLOCKED, not executed.
//     Duplicating that check here would be theatre — and worse, it would rot independently of the real gate.
//
// USAGE
//   node tools/exercise/exercise.cjs status
//   node tools/exercise/exercise.cjs reload
//   node tools/exercise/exercise.cjs ask "track 1Z27691W0233595715"
//
// REQUIRES Chrome started with --remote-debugging-port=9222 (override with ORCHARD_CDP_PORT). That port lets any
// local process drive this browser profile — the same profile holding the live sessions the rides borrow. Open it
// for the build loop, close it after; that exposure is the price of the loop testing itself, and it should be a
// decision each time rather than a permanent flag in a shortcut.

'use strict';

const http   = require('node:http');
const crypto = require('node:crypto');
const fs     = require('node:fs');
const path   = require('node:path');

const PORT = Number(process.env.ORCHARD_CDP_PORT || 9222);
const REPO = path.resolve(__dirname, '..', '..');

/**
 * Chrome derives an unpacked extension's id from its manifest `key`: sha256 of the DER public key, first 16
 * bytes, each nibble mapped 0-15 → a-p. Deriving it (rather than hardcoding) means the allow-list cannot drift
 * out of sync with the extension it is supposed to be protecting. PURE — the self-test covers it.
 */
function extensionIdFromKey(base64Key) {
  const der = Buffer.from(String(base64Key || ''), 'base64');
  const hash = crypto.createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0x0f));
  }
  return id;
}

function manifest() {
  return JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
}

function getJSON(urlPath, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: urlPath, timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

function die(msg, hint) {
  console.error(`\n  ✗ ${msg}`);
  if (hint) console.error(`    ${hint}`);
  console.error('');
  process.exit(1);
}

async function targets() {
  let list;
  try {
    list = await getJSON('/json/list');
  } catch {
    die(`no Chrome remote-debugging port on 127.0.0.1:${PORT}`,
      'start Chrome with --remote-debugging-port=9222 (see the header note about what that exposes), or set ORCHARD_CDP_PORT');
  }
  const id = extensionIdFromKey(manifest().key);
  const prefix = `chrome-extension://${id}/`;
  const mine = (Array.isArray(list) ? list : []).filter((t) => String(t.url || '').startsWith(prefix));
  return { id, prefix, all: list, mine };
}

/** One CDP Runtime.evaluate against ONE allow-listed target. Rejects on JS exception rather than returning junk. */
function evaluate(target, expression, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error('cdp-timeout')); }, timeoutMs);
    const done = (fn, v) => { clearTimeout(timer); try { ws.close(); } catch { /* */ } fn(v); };
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
    ws.onerror = () => done(reject, new Error('cdp-socket-error'));
    ws.onclose  = () => { clearTimeout(timer); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== 1) return;
      if (m.error) return done(reject, new Error(`cdp: ${m.error.message}`));
      const r = m.result || {};
      if (r.exceptionDetails) {
        const t = r.exceptionDetails.exception && (r.exceptionDetails.exception.description || r.exceptionDetails.exception.value);
        return done(reject, new Error(`page threw: ${t || r.exceptionDetails.text}`));
      }
      done(resolve, r.result ? r.result.value : undefined);
    };
  });
}

/** The panel is the only context that can dispatch a turn, and the only one whose sendMessage reaches the SW. */
async function panelTarget() {
  const { mine, id } = await targets();
  const panel = mine.find((t) => t.type === 'page' && /chat\.html/i.test(String(t.url)));
  if (!panel) {
    const seen = mine.map((t) => `${t.type} ${String(t.url).replace(`chrome-extension://${id}/`, '')}`).join(', ') || 'none';
    die('the Orchard side panel is not open (no chat.html target)',
      `open the side panel and retry — extension ${id}; targets seen: ${seen}`);
  }
  return panel;
}

const send = (msg) => `chrome.runtime.sendMessage(${JSON.stringify(msg)})`;

async function cmdStatus() {
  const { id, mine, all } = await targets();
  console.log(`\n  port      127.0.0.1:${PORT}  (${all.length} target(s) total)`);
  console.log(`  extension ${id}`);
  if (!mine.length) return die('no Orchard targets — is the extension loaded in this Chrome profile?');
  for (const t of mine) console.log(`    · ${t.type.padEnd(15)} ${String(t.url).replace(`chrome-extension://${id}/`, '')}`);
  const panel = mine.find((t) => t.type === 'page' && /chat\.html/i.test(String(t.url)));
  if (!panel) { console.log('\n  panel     CLOSED — `ask` and `reload` need it open\n'); return; }
  const v = await evaluate(panel, 'chrome.runtime.getManifest().version', { timeoutMs: 5000 });
  console.log(`\n  live      v${v}`);
  console.log(`  repo      v${manifest().version}`);
  console.log(v === manifest().version ? '  ✓ live build matches the working tree\n' : '  ! live build is STALE vs the working tree — run `reload`\n');
}

async function cmdReload() {
  const panel = await panelTarget();
  const before = await evaluate(panel, 'chrome.runtime.getManifest().version', { timeoutMs: 5000 });
  console.log(`  reloading from v${before} …`);
  // The SW answers before it restarts (EX-1), but the reload tears down this very page a moment later, so a
  // socket error here is expected and means the reload took — not that it failed. Confirm by re-attaching.
  try { await evaluate(panel, send({ type: 'DEV_RELOAD_EXTENSION', payload: { reason: 'exercise.cjs' } }), { timeoutMs: 8000 }); }
  catch { /* expected: the target died mid-call */ }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const { mine } = await targets();
      const p = mine.find((t) => t.type === 'page' && /chat\.html/i.test(String(t.url)));
      if (!p) continue;
      const after = await evaluate(p, 'chrome.runtime.getManifest().version', { timeoutMs: 3000 });
      if (after) {
        console.log(`  ✓ back up on v${after}${after === before ? '  (same version — did the build change manifest.json?)' : ''}`);
        return;
      }
    } catch { /* still restarting */ }
  }
  die('extension did not come back within 20s', 'check chrome://extensions for a load error');
}

async function cmdAsk(text) {
  if (!text || !String(text).trim()) die('usage: exercise.cjs ask "<the ask>"');
  const panel = await panelTarget();
  const r = await evaluate(panel, send({ type: 'DEV_RUN_ASK', payload: { ask: String(text) } }), { timeoutMs: 20000 });
  if (!r || r.success !== true) die(`ask refused: ${(r && (r.error || r.hint)) || 'no reply'}`);
  console.log(`  ✓ dispatched in conversation ${r.conversationId || '(unknown)'}`);
  console.log('    the OUTCOME is in the fleet trace, not here — grade it against the pass\'s VALIDATE block.');
}

// EX-3 — the whole self-verifying pass in one call: queue the asks, restart into them, let the panel drain on the
// other side. Returns as soon as the intent is persisted; the restart and the asks happen without us.
async function cmdExercise(asks) {
  if (!asks.length) die('usage: exercise.cjs exercise "<ask>" ["<ask>" …]');
  const panel = await panelTarget();
  try {
    const r = await evaluate(panel, send({ type: 'DEV_EXERCISE', payload: { asks, reload: true } }), { timeoutMs: 8000 });
    if (r && r.success === false) die(`refused: ${r.error}`);
  } catch { /* expected — the reload tears down this target mid-call */ }
  console.log(`  ✓ queued ${asks.length} ask(s) + reload; the panel drains them after it boots`);
  console.log('    watch the trace for `EXERCISE ▸ drain complete`, then grade against the VALIDATE block.');
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'status':   return cmdStatus();
    case 'reload':   return cmdReload();
    case 'ask':      return cmdAsk(rest.join(' '));
    case 'exercise': return cmdExercise(rest.map((s) => String(s).trim()).filter(Boolean));
    default:
      console.error('\n  usage: exercise.cjs status | reload | ask "<the ask>" | exercise "<ask>" ["<ask>" …]\n');
      process.exit(2);
  }
}

if (require.main === module) main().catch((e) => die(String((e && e.message) || e)));

module.exports = { extensionIdFromKey };
