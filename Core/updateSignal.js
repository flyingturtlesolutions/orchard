// Core/updateSignal.js — SU-2 (DESIGN_self_update.md §3.3) the PURE decision logic for the extension's
// self-update signal: given a poll of update/ready.json, the loaded manifest version, and the set of versions
// already announced, decide whether to ARM the reload dot and which `UPDATE ▸` line to log. No DOM, no chrome —
// the service-worker + panel glue (background.js, chat.js) call these and own all IO. Tested in the npm gate
// (Core/updateSignal.test.js). Mirrors promoteChecks.cjs's semver, but this is the shipped ESM twin (Core/ can't
// import a tools/ cjs) — the two are trivially small and independently tested.

/** Compare dotted numeric versions ("2.74.2224"). → -1 | 0 | 1. Missing/ragged parts compare as 0. */
export function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10));
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * Decide the reload-dot arm + which `UPDATE ▸ ready` line to log, from a poll of update/ready.json.
 * Arm ONLY when disk is strictly NEWER than loaded — a force-pushed-back fleet would otherwise invite the
 * storage-shape-breaking downgrade ruling 3 forbids; an older disk logs `ready-older` (informational) and never arms.
 * @param {{ok:boolean, version?:string, sha?:string}|null} poll  the SW fetch result ({ok:false} on absent/reject)
 * @param {string} loadedVersion  chrome.runtime.getManifest().version
 * @param {string[]|Set<string>} seen  versions already announced (PERSISTED — a cold SW boot must not re-log)
 * @returns {{arm:boolean, armVersion:(string|null), log:(null|{kind:('ready'|'ready-older'), disk:string, loaded:string})}}
 */
export function evaluateReady(poll, loadedVersion, seen) {
  if (!poll || !poll.ok || !poll.version || !loadedVersion) return { arm: false, armVersion: null, log: null };
  const c = cmpVersion(poll.version, loadedVersion);
  if (c === 0) return { arm: false, armVersion: null, log: null };                                               // up to date
  if (c < 0) return { arm: false, armVersion: null, log: { kind: 'ready-older', disk: poll.version, loaded: loadedVersion } };   // downgrade — never arm
  const has = seen instanceof Set ? seen.has(poll.version) : (Array.isArray(seen) && seen.includes(poll.version));
  return { arm: true, armVersion: poll.version, log: has ? null : { kind: 'ready', disk: poll.version, loaded: loadedVersion } };
}

/**
 * Decide the boot-diary `applied` beacon (§3.4). Any change between the last-run version and the now-loaded
 * version means an update landed (button click, Chrome restart, or files swapped while Chrome was closed).
 * @returns {{changed:boolean, from:(string|null), to:(string|null)}}
 */
export function evaluateBoot(lastRunVersion, loadedVersion) {
  if (!loadedVersion) return { changed: false, from: null, to: null };
  if (lastRunVersion === loadedVersion) return { changed: false, from: lastRunVersion, to: loadedVersion };
  return { changed: true, from: lastRunVersion || null, to: loadedVersion };
}

/** Keep only version chars — defense-in-depth so a hostile ready.json version can't inject extra log lines. */
function _ver(v) { return String(v || '').replace(/[^\d.]/g, ''); }

/** The `UPDATE ▸ ready` / `ready-older` line for a log from evaluateReady. */
export function formatReady(log) {
  const stem = log.kind === 'ready-older' ? 'ready-older' : 'ready';
  return `UPDATE ▸ ${stem} v${_ver(log.disk)} (loaded v${_ver(log.loaded)})`;
}

/** The `UPDATE ▸ applied` boot beacon. lagMins null → `lag=unknown` (ready.json absent/stale, §3.4). */
export function formatApplied(from, to, lagMins) {
  return `UPDATE ▸ applied v${to}${from ? ` from v${from}` : ''} lag=${lagMins == null ? 'unknown' : lagMins + 'm'}`;
}

/**
 * The `UPDATE ▸ updater` heartbeat line relayed from a raw updater-state.json (§3.3.4). Carries the per-clone
 * GUID (F6 dedup key) so N Chrome profiles on one clone collapse to one logical updater in glf. → null if empty.
 */
export function updaterLine(state, nowSec) {
  if (!state || typeof state !== 'object') return null;
  // strip anything not word/dot/dash from the free-ish fields — defense-in-depth so a locally-tampered
  // updater-state.json can't inject extra lines into the delimited CW ring (security pass).
  const clean = (s) => String(s || '').replace(/[^\w.:-]/g, '');
  const head = clean(state.head || '?');
  const st = clean(state.state || (state.fetchOk === false ? 'error' : 'ok'));
  const age = (typeof state.at === 'number' && typeof nowSec === 'number') ? Math.max(0, Math.round((nowSec - state.at) / 60)) : null;
  const guid = state.guid ? ` guid=${clean(state.guid)}` : '';
  return `UPDATE ▸ updater head=${head} state=${st} fetchOk=${state.fetchOk !== false}${age == null ? '' : ` age=${age}m`}${guid}`;
}

/**
 * Throttle the heartbeat relay: ship when the state/fetchOk/head CHANGES, or at least once per 24h — otherwise a
 * healthy fleet would flood glf with identical `ok` lines (§3.3.4). prev/cur = {state, fetchOk, head}.
 */
export function shouldRelay(prev, cur, lastRelayAtSec, nowSec) {
  if (!cur) return false;
  if (!prev) return true;
  if (prev.state !== cur.state || prev.fetchOk !== cur.fetchOk || prev.head !== cur.head) return true;
  if (typeof lastRelayAtSec === 'number' && typeof nowSec === 'number' && (nowSec - lastRelayAtSec) >= 24 * 3600) return true;
  return false;
}
