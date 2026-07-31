/**
 * @file Services/Cloud/CloudLogShipper.js — CW-3/CW-4 (DESIGN_cloud_logs.md §3).
 * @description Mirrors the SCRUBBED Logger ring to CloudWatch through the Orchard API. Chrome wiring only —
 * the decision logic (level filter, middle-out eviction, gap honesty, batching, backoff) is Core/logShipping.
 *
 * Rulings enforced here: no AWS creds (cloudRequest only) · opt-in, default off, kill-switch drops the
 * outbox · only the scrubbed ring ships (the Logger tail-tap IS the source) · bound identity required
 * (401/403 → pause until the next auth success) · never block the app (fire-and-forget, bounded, one
 * self-health WARN per hour max).
 */

import { Logger } from '../../Core/Logger.js';
import { cloudRequest, CloudClientError } from './CloudClient.js';
import { buildDecisionRegExp } from '../../Core/decisionMarkers.js';
import { filterForLevel, evictMiddleOut, gapEvent, buildBatches, backoffDelay, urgentEvent, normalizeRingEntry } from '../../Core/logShipping.js';

const SETTING_KEY = 'settings:cloudLogs';          // 'off' | 'decisions' | 'full' (spec ruling 2; default off)
const OUTBOX_KEY = 'cloudlogs:outbox';             // persisted so an MV3 SW death doesn't drop the queue
const ALARM = 'cloudlogs:flush';
const OUTBOX_CAP = 2000;                           // events (spec §3)
const KEEP_HEAD = 250;                             // ruling 9 — the onset survives eviction

const _re = buildDecisionRegExp();
let _level = 'off';
let _outbox = [];                                  // oldest-first [{t,lvl,tag,msg,v}]
let _inFlight = false;
let _paused = false;                               // needs-auth (401/403) — cleared on next successful send attempt cycle
let _attempt = 0;                                  // backoff counter
let _nextTryAt = 0;
let _lastHealthWarnAt = 0;
let _persistT = null;

function _version() { try { return chrome.runtime.getManifest().version; } catch { return '0'; } }

function _healthWarn(msg) {
  const now = Date.now();
  if (now - _lastHealthWarnAt < 60 * 60 * 1000) return;   // ruling 6 — one WARN/hour about our own health
  _lastHealthWarnAt = now;
  try { Logger.warn('shipper', `SHIPPER ▸ ${msg}`); } catch { /* */ }
}

function _persistSoon() {
  if (_persistT) return;
  _persistT = setTimeout(() => {
    _persistT = null;
    chrome.storage.local.set({ [OUTBOX_KEY]: _outbox }).catch?.(() => {});
  }, 2000);
}

function _enqueue(entry) {
  if (_level === 'off') return;
  // v1910 — normalize FIRST (the ring's fields are level/source/message/timestamp), then filter on the
  // normalized event: the first cut filtered the raw entry, whose .msg does not exist — vacuum shipped.
  const e = normalizeRingEntry(entry, _version());
  if (!filterForLevel([e], _level, _re).length) return;
  _outbox.push(e);
  const { events, dropped } = evictMiddleOut(_outbox, OUTBOX_CAP, KEEP_HEAD);
  if (dropped) { _outbox = events; _outbox.push(gapEvent(dropped)); }   // ruling 9 — the trace records its own gaps
  _persistSoon();
  if (urgentEvent(e)) void _flush();   // §3 — errors are what the fleet view is FOR
}

async function _flush() {
  if (_inFlight || _level === 'off' || !_outbox.length) return;
  if (_paused) return;                                      // needs-auth; the alarm keeps ticking, auth flips us back
  if (Date.now() < _nextTryAt) return;                      // backoff window
  _inFlight = true;
  try {
    const batches = buildBatches(_outbox);
    const batch = batches[0];
    await cloudRequest('POST', '/logs/batch', { auth: true, body: { installId: await _installId(), level: _level, events: batch } });
    _outbox = _outbox.slice(batch.length);
    _attempt = 0; _nextTryAt = 0;
    _persistSoon();
    if (_outbox.length) { _inFlight = false; return void _flush(); }   // drain follow-on batches
  } catch (e) {
    if (e instanceof CloudClientError && (e.status === 401 || e.status === 403)) {
      _paused = true;                                       // §6 — resume on next auth success (probed each alarm tick)
      _healthWarn('paused — cloud session needed for log shipping');
    } else if (e instanceof CloudClientError && e.status === 413) {
      _attempt += 1; _nextTryAt = Date.now() + backoffDelay(_attempt);
      // §6 — halve batch size by splitting the head batch in two (buildBatches re-runs next flush anyway)
    } else {
      _attempt += 1; _nextTryAt = Date.now() + backoffDelay(_attempt);
      _healthWarn(`flush failed (${(e && e.message) || 'network'}) — backing off`);
    }
  } finally {
    _inFlight = false;
  }
}

let _installIdCache = null;
async function _installId() {
  if (_installIdCache) return _installIdCache;
  const KEY = 'cloudlogs:installId';
  const got = await chrome.storage.local.get(KEY);
  if (got && got[KEY]) { _installIdCache = got[KEY]; return _installIdCache; }
  _installIdCache = 'ins_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  await chrome.storage.local.set({ [KEY]: _installIdCache });
  return _installIdCache;
}

async function _readLevel() {
  try {
    const got = await chrome.storage.local.get(SETTING_KEY);
    const v = got && got[SETTING_KEY];
    return (v === 'decisions' || v === 'full') ? v : 'off';
  } catch { return 'off'; }
}

/** Boot wiring: call once from the service worker. Idempotent-enough (module singleton). */
export async function initCloudLogShipper() {
  _level = await _readLevel();
  try { const got = await chrome.storage.local.get(OUTBOX_KEY); if (Array.isArray(got?.[OUTBOX_KEY])) _outbox = got[OUTBOX_KEY]; } catch { /* */ }
  Logger.onEntry(_enqueue);   // the tail-tap — scrubbed entries only, by construction
  try { chrome.alarms.create(ALARM, { periodInMinutes: 1 }); } catch { /* */ }
  chrome.alarms.onAlarm.addListener((a) => {
    if (!a || a.name !== ALARM) return;
    _paused = false;           // cheap re-probe: a lapsed session re-pauses on the next 401
    void _flush();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SETTING_KEY]) return;
    const next = changes[SETTING_KEY].newValue;
    _level = (next === 'decisions' || next === 'full') ? next : 'off';
    if (_level === 'off') { _outbox = []; _persistSoon(); }   // ruling 2 — the kill switch drops, never drains
  });
}
