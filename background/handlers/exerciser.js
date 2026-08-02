// background/handlers/exerciser.js — EX-1 (v2.74.1946): THE LOOP'S TWO MISSING HANDS.
//
// The build→gl→diagnose→fix→verify loop automated its transport (glf), its trigger (auto-glf) and its landing
// (auto-bcp). What it could never do is CAUSE the event it grades. On 2026-08-02 five auto-glf ticks fired and
// four came back INCONCLUSIVE — not one for a bad diagnosis. They failed on: a stale build (the extension had
// been reloaded before the fix landed, twice), an ask sent in a conversation that lacked the connection
// (`PALETTE ▸ 118`), and a precondition nobody was there to satisfy. The loop had become a very capable observer
// of a world it could not touch.
//
// These two handlers close that gap and nothing more:
//   DEV_RELOAD_EXTENSION — restart the extension so a just-built SW change is actually the one running.
//   DEV_RUN_ASK          — put an ask through the panel's real front door and report where it landed.
//
// WHAT THIS IS NOT: a verifier. The ask's OUTCOME is never in the response — it is in the fleet trace, graded
// against the pass's `VALIDATE[…]` block. DEV_RUN_ASK answers "dispatched, in conversation X" and returns
// immediately; a turn can run 20s and a caller that waits for it learns nothing the log won't say better.
//
// TRUST: extension-internal only. `chrome.runtime.sendMessage` does not cross the extension boundary without
// `externally_connectable` (this manifest has none), so a web page cannot reach these. They are still DEV
// affordances that drive the agent, so every invocation logs — an unlogged remote-drive would be exactly the
// kind of surface the dev-bridge trust rules exist to keep visible (CLAUDE.md, "Trust rules for the dev-bridge").

import { Logger } from '../../Core/Logger.js';

export function createExerciserHandlers() {
  return {
    // Restart the extension. The caller is answered BEFORE the reload, because chrome.runtime.reload() tears down
    // this service worker mid-flight — a caller still awaiting sendResponse would hang until its own timeout and
    // then report a failure for an operation that in fact succeeded.
    'DEV_RELOAD_EXTENSION': (payload, sender, sendResponse) => {
      const why = String((payload && payload.reason) || 'dev').slice(0, 120);
      try { Logger.info('background', `EXERCISE ▸ reload requested (${why}) — extension restarting`); } catch { /* */ }
      try { sendResponse({ success: true, reloading: true }); } catch { /* */ }
      // Small delay so the response and the log line both flush before the context dies.
      setTimeout(() => { try { chrome.runtime.reload(); } catch { /* */ } }, 200);
      return true;
    },

    // Run an ask in the OPEN conversation, through the panel's real entry point.
    //
    // Scope, stated rather than implied: this does NOT switch conversations. Today's misses came from asking in a
    // conversation without the connection, so the response reports the conversation it landed in — enough for the
    // loop to detect the mistake — but choosing the conversation still belongs to whoever opens the panel.
    // Switching means driving the Rail's state machine, which is a bigger change than this one earns.
    'DEV_RUN_ASK': (payload, sender, sendResponse) => {
      (async () => {
        const ask = String((payload && payload.ask) || '').trim();
        if (!ask) { sendResponse({ success: false, error: 'no-ask' }); return; }
        try {
          // The panel is the only context that can dispatch a turn; if it is closed this throws, and "open the
          // panel" is a real, actionable answer rather than a silent no-op.
          const r = await chrome.runtime.sendMessage({ type: 'DEV_ASK_INJECT', payload: { ask } });
          if (!r || r.success !== true) {
            try { Logger.info('background', `EXERCISE ▸ ask REFUSED by panel: ${(r && r.error) || 'no-reply'}`); } catch { /* */ }
            sendResponse({ success: false, error: (r && r.error) || 'panel-refused' });
            return;
          }
          try { Logger.info('background', `EXERCISE ▸ ask dispatched → conversation ${r.conversationId || '?'} · "${ask.slice(0, 60)}"`); } catch { /* */ }
          sendResponse({ success: true, dispatched: true, conversationId: r.conversationId || null });
        } catch {
          try { Logger.info('background', 'EXERCISE ▸ ask BLOCKED — side panel is closed (no context to dispatch a turn)'); } catch { /* */ }
          sendResponse({ success: false, error: 'panel-closed', hint: 'open the Orchard side panel, then retry' });
        }
      })();
      return true;
    },
  };
}
