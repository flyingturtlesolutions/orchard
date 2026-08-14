// background/handlers/updatePoll.js — SU-2 (DESIGN_self_update.md §3.3) the SERVICE-WORKER half of the fleet
// self-update signal. The SW DETECTS disk-newer-than-loaded and PUBLISHES it to chrome.storage.local; the panel
// (chat.js) arms the reload dot from that published state — an MV3 service worker cannot touch panel DOM, so
// detection and arming are split across the storage boundary (review F4). Also the boot diary (§3.4) and the
// throttled updater heartbeat relay (§3.3.4). Thin glue (outside the npm test glob — node --check + undef only);
// every DECISION lives in the pure Core/updateSignal.js, every I/O lives here.

import { Logger } from '../../Core/Logger.js';
import { evaluateReady, evaluateBoot, formatReady, formatApplied, updaterLine, shouldRelay } from '../../Core/updateSignal.js';

const ALARM = 'orchard-update-poll';
const SIGNAL_KEY = 'update:signal';          // {readyVersion, readySha, at} — the panel reads this to arm the dot
const SEEN_KEY = 'update:seenReady';         // persisted version[] so a cold SW boot doesn't re-log `ready`
const LASTRUN_KEY = 'update:lastRunVersion'; // the boot diary's memory (§3.4)
const RELAY_KEY = 'update:lastRelay';        // {state,fetchOk,head,at} — heartbeat throttle memory
const POLL_MIN = 5;

function _loadedVersion() { try { return chrome.runtime.getManifest().version; } catch { return ''; } }
function _nowSec() { return Math.floor(Date.now() / 1000); }
async function _get(key, dflt) { try { const g = await chrome.storage.local.get(key); return (g && g[key] !== undefined) ? g[key] : dflt; } catch { return dflt; } }
async function _set(obj) { try { await chrome.storage.local.set(obj); } catch { /* */ } }

/** Fetch update/ready.json off the LIVE extension dir. Absent → the fetch REJECTS (not a 404 Response), so
 *  catch → {ok:false} (§3.3.1 — an unmanaged install has no ready.json and stays inert). */
async function _pollReady() {
  try {
    const r = await fetch(chrome.runtime.getURL('update/ready.json'), { cache: 'no-store' });
    if (!r.ok) return { ok: false };
    const j = await r.json();
    return { ok: true, version: j.version, sha: j.sha, at: j.at };
  } catch { return { ok: false }; }
}
async function _readUpdaterState() {
  try {
    const r = await fetch(chrome.runtime.getURL('update/updater-state.json'), { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** One poll tick: publish the arm signal + log `ready` (once per version), then relay the throttled heartbeat. */
export async function pollUpdate() {
  const loaded = _loadedVersion();

  const poll = await _pollReady();
  const seen = await _get(SEEN_KEY, []);
  const dec = evaluateReady(poll, loaded, Array.isArray(seen) ? seen : []);
  if (dec.arm) await _set({ [SIGNAL_KEY]: { readyVersion: dec.armVersion, readySha: (poll && poll.sha) || '', at: _nowSec() } });
  if (dec.log) {
    try { Logger.info('background', formatReady(dec.log)); } catch { /* */ }
    if (dec.log.kind === 'ready') await _set({ [SEEN_KEY]: (Array.isArray(seen) ? seen : []).concat(dec.log.disk).slice(-20) });
  }

  const st = await _readUpdaterState();
  if (st) {
    const cur = { state: st.state || (st.fetchOk === false ? 'error' : 'ok'), fetchOk: st.fetchOk !== false, head: st.head };
    const prev = await _get(RELAY_KEY, null);
    if (shouldRelay(prev, cur, prev && prev.at, _nowSec())) {
      const line = updaterLine(st, _nowSec());
      if (line) { try { Logger.info('background', line); } catch { /* */ } }
      await _set({ [RELAY_KEY]: { ...cur, at: _nowSec() } });
    }
  }
}

/** §3.4 boot diary — a change between the last-run version and the now-loaded version means an update landed
 *  (button click, Chrome restart, or files swapped while Chrome was closed). lag from ready.json.at, else unknown. */
export async function runBootDiary() {
  const loaded = _loadedVersion();
  const last = await _get(LASTRUN_KEY, undefined);
  const boot = evaluateBoot(last, loaded);
  if (!boot.changed) return;
  let lag = null;
  const poll = await _pollReady();
  if (poll.ok && typeof poll.at === 'number') lag = Math.max(0, Math.round((_nowSec() - poll.at) / 60));
  try { Logger.info('background', formatApplied(boot.from, boot.to, lag)); } catch { /* */ }
  await _set({ [LASTRUN_KEY]: loaded });
}

/** Register on SW boot (like the fleet/vitals/cadence alarm owners): a durable 5-min poll alarm + a boot diary
 *  + one immediate poll so a freshly-landed update signals without waiting a full period. */
export function initUpdatePoll() {
  try {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (!alarm || alarm.name !== ALARM) return;
      pollUpdate().catch((e) => { try { Logger.warn('background', `update poll: ${e?.message || e}`); } catch { /* */ } });
    });
    chrome.alarms.create(ALARM, { periodInMinutes: POLL_MIN });
  } catch (e) { try { Logger.warn('background', `initUpdatePoll: ${e?.message || e}`); } catch { /* */ } }
  runBootDiary().catch(() => {});
  pollUpdate().catch(() => {});
}
