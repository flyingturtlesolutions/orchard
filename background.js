/**
 * @file background.js
 * @description Agent HUB — Manifest V3 service worker.
 *
 * Message types handled:
 *   START_WALK        — Opens a new focused tab, runs TemplateWalker recursive discovery.
 *   RUN_TEST          — Validates, injects, enqueues job.
 *   SET_API_KEY       — Persists Anthropic API key.
 *   GET_API_KEY       — Returns masked key.
 *   CHECK_API_KEY     — Returns boolean hasKey.
 *   GET_CLOUD_STATUS  — Orchard cloud auth + settings summary (P0).
 *   CLOUD_SIGN_IN     — Cognito hosted UI sign-in.
 *   CLOUD_SIGN_OUT    — Clear cloud session.
 *   CLOUD_GET_ME      — GET /identity/me (read-only P0).
 *   CLOUD_GET_OBJECT  — GET /objects/{path} (read-only P0).
 *   GET_GROUNDS       — Returns all Ground records.
 *   GET_RESULTS       — Returns recent JobResult records.
 *   GET_LOGS          — Returns persisted log entries.
 *   CLEAR_LOGS        — Clears log storage.
 *
 * @module background
 * @author Agent HUB
 */

import { Logger, LOG_LEVEL }  from './Core/Logger.js';
import { installGlobalErrorHandlers } from './Core/ErrorCapture.js';
import { livePromptTexts, livePromptMeta } from './Core/promptCatalog.js';   // v1710 — the Docs tab's live prompt catalog (no drift)
import * as Locale          from './Core/locale.js';   // v2.74.397 — Perspective/Locale builder + query API
import * as Outcomes           from './Core/outcomes.js';    // v2.74.413 — OutcomeEvent stream + rollups
import * as SiteMap            from './Core/siteMap.js';     // v2.74.431 — Ground siteMap (GROUND_SPEC § 7)
import * as CapabilitySynth    from './Core/capabilitySynth.js';  // v2.74.471 — synthesize capability from a goal
import { serializeGaps, deserializeGaps } from './Core/gapRegistry.js';  // PS-0 — persist/read Orchard's per-Ground capability-gap registry
import { serializePool, deserializePool } from './Core/observedPool.js';  // PS-2 — the long-tail observed pool (catch-net for un-anticipated controls)
import { synthesizeTrialOp, classifyTrialSafety, scoreTrial } from './Core/trialSynth.js';  // PB-3/4/5 — trial op + safety + scoring
import { coverComplete }       from './Core/cover.js';      // SG-3 Cover — completeness floor
import { selectionToTrialRoles } from './Core/bind.js';     // SG-4 Bind — selection → trial roles bundle
import { buildAcceptance, landmarkRefActions } from './Core/accept.js';     // SG-5/PB-7 — passing trial → durable capability + landmark-backed Fragment/Strategy
import { deriveCapabilities, deriveAllowedOperations } from './Services/LandmarkProfile.js';  // SG-LM-4b — accept-time landmark profiling
import { createSgMessageHandlers, markEngineBusy } from './background/handlers/sg.js';  // R1 seed — SG handlers behind a registry; markEngineBusy v2.74.911
import { createExploreHandlers } from './background/handlers/explore.js';  // v2.74.951 (CR-X3a) — the explore domain
import { createDiscoveryHandlers } from './background/handlers/discovery.js';  // v2.74.952 (CR-X3b) — the discovery domain
import { createForageHandlers } from './background/handlers/forage.js';  // §19 — Forage: the read-safe nav-following recipe-capture crawler
import { createWorkflowDebugHandlers } from './background/handlers/workflowDebug.js';  // v2.74.953 (CR-X3c) — the workflow + debugger domain
import { createConnectorHandlers } from './background/handlers/connector.js';  // v2.74.1151 (CX-3) — the connector domain (session-ride)
import { createExerciserHandlers } from './background/handlers/exerciser.js';  // EX-1 (v2.74.1946) — self-reload + programmatic ask (the loop's two missing hands)
import { createCanvasHandlers } from './background/handlers/canvas.js';  // v2.74.1205 (CA-4) — the canvas domain (RENDER_CANVAS → the presentation tab)
import { createFleetHandlers, registerFleetAlarmListener } from './background/handlers/fleet.js';  // FL-6 (v2.74.1355) — the fleet clock trigger (scheduled headless sweeps)
import { createConnectionsHandlers, registerConnTransitionListener, readConnRegistry, reportAuthSignal } from './background/handlers/connections.js';  // CP-1/2 (v2.74.1506) — the connections auth-presence registry; VT (v2.74.1570) — the heartbeat moved into the vitals scheduler; the transition listener feeds vitals incidents + the sign-in catch-up
import { createPipelineHandlers } from './background/handlers/pipeline.js';   // PP (v2.74.1665, DESIGN_peritem_pipeline.md §5.7/§9.3) — the per-item CASE sidecar (vitals-pattern store; the Conversation record cannot hold case state)
import { initVitals, onConnTransition, createVitalsHandlers } from './background/handlers/vitals.js';   // VT-0..4 (v2.74.1569-1572, DESIGN_vitals.md) — the outcome funnel + scheduler + daily visit + incident store
import { initCadence, createCadenceHandlers } from './background/handlers/cadence.js';   // CD-1 (v2.74.1692, DESIGN_cadence.md §2/§5) — the one clock owner for time-triggered workflows (scanner + headless fire + run history)
import { buildRawAction, coalesce } from './Core/observedTrace.js';     // OBS-1 — observed demonstration recorder
import * as ChromeHoist        from './Core/chromeHoist.js';  // v2.74.480 — hoist recurring chrome off Locales → Ground.chrome
import * as Workflows          from './Core/workflows.js';   // v2.74.488 — cross-Locale workflows (partOf) over the siteMap
import { ExecutionEngine }    from './Services/ExecutionEngine.js';
import { StorageManager }     from './Services/StorageManager.js';
import { AnthropicService }   from './Services/AnthropicService.js';
import { CapabilityAPI, EVENT as CAP_EVENT } from './Services/CapabilityAPI.js';
import { TemplateWalker }     from './Services/TemplateWalker.js';
import { PageClassifier }     from './Services/PageClassifier.js';
// v2.71.4 — ConversationStore for background-side terminal-event persistence.
// Lets chat-launched invocations write their result back to the conversation
// even when the chat panel is closed at completion time.
import { ConversationStore }  from './Services/ConversationStore.js';
// v2.74.145 / v2.74.146 — Shared image-capture pipeline (snap / full /
// read). Used by both the OBSERVE_IMAGE_*_BG message handlers
// (sidepanel verify) and ExecutionEngine (runtime). ExecutionEngine
// runs in this same SW, so it imports + calls directly instead of
// self-messaging (which closes the response port immediately in MV3
// module SWs).
import {
  performImageSnap,
  performImageFull,
  performImageRead,
} from './Services/ImageReadCapture.js';
// v2.74.277 — Static imports for substrate modules (Phases 5-10.5).
// Chrome MV3 service workers disallow dynamic `import()` per HTML
// spec; the prior `await import(...)` lazy-load pattern in handlers
// would fail with: "import() is disallowed on
// ServiceWorkerGlobalScope". All substrate modules now eagerly load
// at SW startup, which is fine — these modules are small + the
// startup is already paying for many other imports.
import { listLandmarksForGround, resolveLandmarkRef } from './Services/LandmarkResolver.js';
import { listActivePerspectives }                          from './Services/PerspectivePredicates.js';
import { canTrack }                                        from './Core/monitorConsent.js';   // C2b — auto-monitor eligibility (global enable ∧ host not excluded)
import { analyzeLandmarkImpact }                      from './Services/LandmarkImpactAnalysis.js';
import { analyzeDeletionImpact }                     from './Services/Storage/ReferenceStore.js';
import { bindPublicIdentity }                        from './Services/Storage/IdentityStore.js';
import { publishPrimitive, listOutgoingPublications, getOutgoingPublication } from './Services/Storage/PublicationStore.js';
import { importPublicationPackage, listIncomingPublications, checkForUpdates, applyUpdate } from './Services/Storage/PublicationImport.js';
import { fetchPublication, searchPublications } from './Services/Cloud/CloudClient.js';
import {
  createWorkspace, listWorkspaces, getWorkspace, renameWorkspace,
  addWorkspaceMember, removeWorkspaceMember,
} from './Services/Cloud/CloudClient.js';
import {
  archiveExecution, getExecutionArchive, deleteExecutionArchive,
} from './Services/Cloud/CloudClient.js';
import { emit as emitGroundEvent_bg,
         list as listGroundEvents_bg,
         clear as clearGroundEvents_bg }              from './Services/GroundEventBus.js';
import { verifyLandmark,
         verifyStaleSuspectedOnGround }               from './Services/LandmarkVerifier.js';
import { replaceLandmarkReferences }                  from './Services/LandmarkReplacer.js';
import { findReplacementCandidates }                  from './Services/LandmarkReplacementCandidates.js';
// v2.74.312 — Verify-time effect observation. Brackets an authoring
// Verify dispatch with the same observation machinery the runtime
// uses (Phase 6.5), so the author can confirm an action's declared
// effect against what actually happens — before save, not just at run.
import { bracket as observeActionBracket,
         classifyEffectDrift }                        from './Services/ActionEffectObserver.js';
// v2.74.329 — GROUND_SPEC § 5 derived-intent cache validation.
import { derivationInputsHash, DERIVATION_VERSION }   from './Core/groundDerivation.js';
// Orchard cloud P0/P1 — StoragePort seam + cloud sync (AWS_INTEGRATION §17).
import { ChromeStorageAdapter } from './Services/Storage/ChromeStorageAdapter.js';
import { HybridStorageAdapter } from './Services/Storage/HybridStorageAdapter.js';
import { backfillWorkspacePartitionFromLegacy } from './Services/Storage/WorkspacePartitionBackfill.js';
import { initStoragePort, getStoragePortMeta } from './Services/Storage/StoragePort.js';
import { getCloudSettings, setCloudSettings } from './Services/Cloud/CloudSettings.js';
import { isCloudSignedIn, getCloudSession } from './Services/Cloud/CloudTokenStore.js';
import {
  getCloudAuthStatus,
  signInToCloud,
  signOutOfCloud,
} from './Services/Cloud/OrchardAuth.js';
import { getIdentityMe, getCloudObject, invokeConnector, linkConnector, unlinkConnector, listConnectorTools } from './Services/Cloud/CloudClient.js';   // CX-5b — invokeConnector → POST /connectors/invoke (broker); MP-3 — linkConnector → POST /connectors/link/{provider}; CX-5c — unlink + linked-state
import { ensureFreshSession } from './Services/Cloud/CloudTokenStore.js';   // v2.74.1312 — LINK_CONNECTOR preflights the Orchard session before the consent dance
import { getIdentitySummary } from './Core/OrchardIdentity.js';
import { syncBridgeOnStorageChange } from './Services/Sync/SyncBridge.js';
import {
  enableHybridSync,
  disableHybridSync,
  ensureHybridSyncReady,
  enqueueGroundManifestSync,
  getSyncConflicts,
  resetSyncBootstrap,
  resolveSyncConflict,
  runSync,
  scheduleSyncRun,
  forceResyncRecord,
  getGroundWorkspaceMap,
} from './Services/Sync/SyncEngine.js';
import { initCloudLogShipper } from './Services/Cloud/CloudLogShipper.js';   // CW-3 — cloud log mirror (opt-in)
import * as GroundAssetStore from './Services/Storage/GroundAssetStore.js';
import {
  getLastSyncAt,
  getLastSyncResult,
  getOutboxCount,
} from './Services/Storage/IndexedDBStore.js';
import { getWorkspacePartitionCount } from './Services/Storage/WorkspacePartitionStore.js';

Logger.setLevel(LOG_LEVEL.DEBUG);
Logger.setPersist(true);

// v2.74.188 — Install global error + unhandledrejection handlers on the
// service worker's `self`. Catches anything thrown out of a top-level
// async callback or an un-awaited Promise that would otherwise vanish
// without ever reaching the Logger (and thus never appearing in the
// Studio Logs tab). Runs before any other code so an error in module
// init still has a handler to catch it.
installGlobalErrorHandlers('background', self);

// PERF ▸ v2.74.1981 — TEMPORARY SW cold-start instrumentation for the "3-4s after reload" investigation. On a COLD
// start these top-level statements run once, after the module graph is parsed. In a service worker performance.now()
// ≈ ms since the SW woke (its timeOrigin), so the `sw:first-dispatch since-wake` line below is the SW's own view of
// how long the panel's first message waited for the cold boot. Remove with the paired chat.js PERF block + the
// Core/decisionMarkers.js 'perf' entry when the measurement is banked.
try { self.__swBootT0 = Date.now(); Logger.info('background', 'PERF ▸ sw:eval-start (cold boot begin)'); } catch (e) { /* */ }

const engine = new ExecutionEngine();
CapabilityAPI.setEngine(engine);

// v2.58.1 — expose PageClassifier on the service worker's global scope so
// its inspection methods (dumpTelemetry, clearTelemetry, rawTelemetry) are
// reachable from the service worker DevTools console. Service workers
// disallow dynamic import() per the HTML spec, so attaching to self is the
// cleanest inspection path. No effect on extension behavior — just adds a
// global reference. Invoke as e.g. `await self.PageClassifier.dumpTelemetry()`.
self.PageClassifier = PageClassifier;

// Run migrations at startup — safe to call on every wake (guarded internally).
// v2.21.0: wipes Path-era data (no backward compat per user decision).
// v2.72.48: renames predicate→assertion in stored records and condition refs.
// Migrations chained: fragment migration first (data shape), then the
// rename (terminology). Both must complete before message handlers read
// stored Fragments / Strategies / Predicates(Assertions).
async function _runMigrations() {
  const fragRes = await StorageManager.migrateToFragmentModel();
  if (fragRes.ran) Logger.info('background', `v2.21.0 migration: wiped ${fragRes.keysRemoved} Path-era keys`);
  const renameRes = await StorageManager.migrateToAssertionRename();
  if (renameRes.ran) {
    Logger.info(
      'background',
      `v2.72.48 migration: renamed ${renameRes.recordsRenamed} predicate→assertion records, updated ${renameRes.refsUpdated} primitives with refs`
    );
  }
}
let _migrationPromise = _runMigrations()
  .catch(err => Logger.error('background', `migration failed: ${err.message}`));

// Orchard P0/P1 — initialize storage port; hybrid when signed in + enabled.
async function refreshStoragePort() {
  try {
    const settings = await getCloudSettings();
    const signedIn = await isCloudSignedIn();
    if (!settings.enabled) {
      if (settings.storageBackend !== 'local') {
        await disableHybridSync();
      }
    } else if (signedIn && settings.storageBackend !== 'hybrid') {
      await enableHybridSync();
    }
    const latest = await getCloudSettings();
    if (latest.enabled && signedIn && latest.storageBackend === 'hybrid') {
      initStoragePort(new HybridStorageAdapter());
      backfillWorkspacePartitionFromLegacy().catch((e) => {
        Logger.warn('background', `workspace partition backfill: ${e.message}`);
      });
    } else {
      initStoragePort(new ChromeStorageAdapter('local'));
    }
    await configureSyncAlarm();
  } catch (e) {
    Logger.warn('background', `refreshStoragePort: ${e.message}`);
    initStoragePort(new ChromeStorageAdapter('local'));
  }
}

async function configureSyncAlarm() {
  try {
    const settings = await getCloudSettings();
    const signedIn = await isCloudSignedIn();
    if (!settings.enabled || !signedIn || settings.storageBackend !== 'hybrid') {
      await chrome.alarms.clear('orchard-sync');
      return;
    }
    const period = Math.max(1, Math.ceil((settings.syncIntervalSec || 30) / 60));
    await chrome.alarms.create('orchard-sync', { periodInMinutes: period });
  } catch (e) {
    Logger.warn('background', `configureSyncAlarm: ${e.message}`);
  }
}

function broadcastSyncApplied(applied) {
  if (!Array.isArray(applied)) return;
  for (const row of applied) {
    if (row?.kind && row?.id) {
      broadcastStorageChanged(row.kind, row.id, row.deleted ? 'deleted' : 'saved');
    }
  }
}

/**
 * Scrub a value before uploading a runtime trace archive (DD-15): redact credential-ish fields and
 * strip URL query/fragments (which can carry tokens/PII). Recursive, depth-bounded. Client-side
 * defense; archives are owner-only but support staff may view them.
 * @param {unknown} value @param {number} [depth]
 */
function _scrubForArchive(value, depth = 0) {
  if (depth > 8 || value == null) return value;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) {
      try { const u = new URL(value); return `${u.origin}${u.pathname}`; } catch { return value; }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => _scrubForArchive(v, depth + 1));
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/pass(word)?|secret|token|api[_-]?key|authorization|credential/i.test(k)) { out[k] = '[redacted]'; continue; }
      out[k] = _scrubForArchive(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Enqueue cloud tombstone + manifest, push immediately, notify UI.
 * @param {string} kind
 * @param {string} id
 * @param {() => Promise<void>} deleteFn
 * @param {string} [groundId]
 */
async function deleteRecordWithSync(kind, id, deleteFn, groundId) {
  await syncBridgeOnStorageChange(kind, id, 'deleted', { groundId });
  await deleteFn();
  if (groundId && kind !== 'ground' && kind !== 'workflow') {
    await enqueueGroundManifestSync(groundId);
  }
  const syncRes = await runSync();
  broadcastSyncApplied(syncRes.applied);
  broadcastStorageChanged(kind, id, 'deleted');
  return syncRes;
}

/** @param {string} groundId @param {{ localeKey?: string, siteMap?: boolean, chrome?: boolean }} assets */
async function syncGroundAssetsAfterSave(groundId, assets = {}) {
  if (!groundId) return;
  const jobs = [];
  if (assets.localeKey) {
    jobs.push(syncBridgeOnStorageChange('locale', assets.localeKey, 'saved', { groundId }));
  }
  if (assets.siteMap) {
    jobs.push(syncBridgeOnStorageChange('siteMap', groundId, 'saved', { groundId }));
  }
  if (assets.chrome) {
    jobs.push(syncBridgeOnStorageChange('chrome', groundId, 'saved', { groundId }));
  }
  if (jobs.length) {
    await Promise.all(jobs);
    scheduleSyncRun();
  }
}

_migrationPromise = _migrationPromise.then(() => refreshStoragePort());
// PERF ▸ v2.74.1981 — TEMPORARY: confirm the top-level migrations are OFF the first-message path (they are never
// awaited by any handler). This observer does not alter the chain. Remove with the rest of the PERF instrumentation.
try { _migrationPromise.then(() => { try { Logger.info('background', `PERF ▸ sw:migrations-done +${Math.round(performance.now())}ms since wake`); } catch { /* */ } }); } catch { /* */ }

initStoragePort(new ChromeStorageAdapter('local'));
getIdentitySummary()
  .then(async ({ publicKeyB64, orchardUserIdPreview }) => {
    // C-P0 — reflect the device's Ed25519 identity onto the §4 LocalUser record (idempotent;
    // independent of cloud sign-in so local-only users still get publicIdentity).
    await bindPublicIdentity({ publicKey: publicKeyB64, publicKeyAlgorithm: 'Ed25519' }).catch(() => {});
    // Prefer the server-authoritative orchardUserId from the cloud session (the namespace all
    // storage/sync actually use) over the locally-derived preview. They differ after a key rotation
    // since DD-01 reuses the original orchardUserId across keys — logging the preview alone is
    // misleading when debugging cloud paths.
    const session = await getCloudSession().catch(() => null);
    const boundId = session?.orchardUserId;
    // v1467 (obs #1) — stamp the BUILD VERSION on the trace's first line: the version is the join key between
    // findings/commits/logs, and "is this a stale build?" burned multiple live round-trips with no way to tell.
    let _v = ''; try { _v = chrome.runtime.getManifest().version; } catch { /* */ }
    Logger.info('background', boundId
      ? `Orchard v${_v} identity ready (orchardUserId ${boundId}; device key preview ${orchardUserIdPreview})`
      : `Orchard v${_v} identity ready (preview ${orchardUserIdPreview}; not bound to cloud)`);
  })
  .catch(err => Logger.warn('background', `Orchard identity init: ${err.message}`));

// CW-3 (DESIGN_cloud_logs.md) — the CloudWatch log shipper: opt-in (settings:cloudLogs, default off),
// tail-taps the SCRUBBED Logger ring, ships through the Orchard API only. Init is fail-safe — a throw here
// must never touch boot.
try { initCloudLogShipper().catch(() => {}); } catch { /* */ }

// v2.74.818 — log the Ground inventory at session start. The duplicate/sibling-Ground class of bug (a cap on a
// host the active-tab-scoped delete can't reach — e.g. app.notion.com vs notion.so) is invisible without a roster
// of every Ground + its capability count. One `GROUNDS ▸` line at startup makes it obvious.
async function _logGroundInventory(reason) {
  try {
    const grounds = (await StorageManager.getAllGrounds()) || [];
    const parts = [];
    for (const g of (Array.isArray(grounds) ? grounds : [])) {
      const gid = g && (g.id || g.groundId); if (!gid) continue;
      let n = 0; try { n = ((await _readSgCapabilities(gid)) || []).length; } catch { /* */ }
      let host = g && g.name; try { if (g && g.url) host = new URL(g.url).hostname; } catch { /* */ }
      parts.push(`${host || gid}(${String(gid).slice(-6)},${n}c)`);
    }
    Logger.info('background', `GROUNDS ▸ ${parts.length} ground(s) [${reason}]: ${parts.join(' · ') || '(none)'}`);
  } catch (e) { Logger.warn('background', `ground inventory log failed: ${e.message}`); }
}

chrome.runtime.onInstalled.addListener(() => {
  // v2.74.799 — mark the session boundary on a REAL reload/install (not idle SW
  // wake) so the Logs download can reliably slice "everything since the reload".
  Logger.markSessionStart();
  _migrationPromise = _runMigrations()
    .catch(err => Logger.error('background', `migration failed: ${err.message}`))
    .finally(() => _logGroundInventory('install/reload').catch(() => {}));   // v2.74.818
});
chrome.runtime.onStartup?.addListener?.(() => {
  Logger.markSessionStart();   // v2.74.799 — browser launch is a new session too
  _migrationPromise = _runMigrations()
    .catch(err => Logger.error('background', `migration failed: ${err.message}`))
    .finally(() => _logGroundInventory('startup').catch(() => {}));   // v2.74.818
  flushSyncIfPending('startup').catch(() => {});
});

async function flushSyncIfPending(reason) {
  try {
    const outbox = await getOutboxCount();
    if (!outbox && reason !== 'online') return;
    const ready = await ensureHybridSyncReady();
    if (!ready.ready) return;
    const res = await runSync();
    if (res.ok) broadcastSyncApplied(res.applied);
    Logger.info('background', `sync flush (${reason}): pushed=${res.pushed ?? 0} pulled=${res.pulled ?? 0} outbox=${res.outboxPending ?? 0}`);
  } catch (e) {
    Logger.warn('background', `sync flush (${reason}): ${e.message}`);
  }
}

self.addEventListener('online', () => {
  flushSyncIfPending('online').catch(() => {});
});

/**
 * v2.27.0 — STORAGE_CHANGED broadcaster.
 *
 * Fired after any CUD operation on a shared record (strategies, fragments,
 * grounds, groundmaps). Both the Studio tab and the chat sidepanel listen
 * and refresh their UIs so edits in one context don't leave the other stale.
 *
 * Uses chrome.runtime.sendMessage, which reaches all extension pages
 * (sidepanel, studio, chat) but not content scripts. Errors are swallowed —
 * if no listener is registered (e.g., only one context is open), sendMessage
 * rejects with "Receiving end does not exist" which is not a real failure.
 *
 * @param {'strategy'|'fragment'|'ground'|'groundmap'} kind
 * @param {string|null} id    - record id, or null for bulk / non-id operations
 * @param {'saved'|'deleted'} action
 */
function broadcastStorageChanged(kind, id, action) {
  chrome.runtime.sendMessage({
    type: 'STORAGE_CHANGED',
    kind, id, action,
    ts: Date.now(),
  }).catch(() => { /* no listeners; fine */ });

  if (action === 'saved') {
    return syncBridgeOnStorageChange(kind, id, action).catch((err) => {
      Logger.warn('background', `sync bridge: ${err?.message || err}`);
    });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'orchard-sync') return;
  runSync()
    .then((res) => {
      if (res.ok) broadcastSyncApplied(res.applied);
    })
    .catch((err) => Logger.warn('background', `sync alarm: ${err?.message || err}`));
});

// FL-6 (v2.74.1355) — the fleet clock: `fleet-sweep:<instanceId>` alarms → the headless propose-only sweep.
// chrome.alarms persist across SW restarts natively, so scheduling once is durable; the listener re-registers
// on every SW boot (this module eval). _invokeSgHandler is hoisted; the map is initialized long before any fire.
registerFleetAlarmListener({ invokeSgHandler: _invokeSgHandler });
// VT-0..4 (v2.74.1569-1572, DESIGN_vitals.md §4) — Ground Vitals: the one `vitals:tick` scanner (absorbs the
// CP-2 `conn:heartbeat` — initVitals clears the old registration), the launch-if-due check, the daily ephemeral
// visit, and the outcome funnel's I/O (the executors call reportLegOutcome; the stores arrive here). The
// connections transition listener feeds vitals its presence incidents + the signed-out→fresh catch-up (VT-4).
initVitals({ invokeSgHandler: _invokeSgHandler, readRideRecipes: _readRideRecipes, writeRideRecipes: _writeRideRecipes, readConnRegistry, reportAuthSignal });
registerConnTransitionListener(onConnTransition);
// CD-1 (v2.74.1692, DESIGN_cadence.md §2/§5) — the ONE clock owner for time-triggered workflows: a single
// `cadence:tick` alarm that scans workflow records and fires the tier-'sw' ones that are due (headless, through
// the normal INVOKE_SESSION executor). Like vitals, the alarm is durable and only the listener re-registers here.
initCadence({
  invokeSgHandler: _invokeSgHandler,
  readRideRecipes: _readRideRecipes,
  // v2.74.2036 — closed-panel cadence presence shares the invoke pulse language
  startPulse: __startPulse,
  stopPulse: __stopPulse,
});


// v2.74.22 — walkAbortFlags + stepApprovalResolvers removed; only the
// AI-walked path used them and that path is gone.

// (discoveryAbortFlags lived here until v2.74.952 — CR-X3b moved it with the discovery domain.)

/**
 * v2.74.23 — Resolve the URL the antecedent fragment should start from.
 * Preference order:
 *   1. The fragment's `url_matches` precondition pattern, if it looks
 *      like a literal URL (auto-captured from currentUrl at authoring
 *      time, so usually is). A regex-style pattern (slashes around it)
 *      isn't navigable; we fall through.
 *   2. The fragment's `startUrl` field (literal authoring URL).
 *   3. null — caller can decide what to do with no URL.
 */
function _resolveAntecedentStartUrl(fragment) {
  if (!fragment) return null;
  // Pull a literal http(s) URL out of a url_matches condition list,
  // skipping regex-style patterns we can't navigate to.
  const findLiteralUrlMatch = (conds) => {
    if (!Array.isArray(conds)) return null;
    for (const c of conds) {
      if (c?.type !== 'url_matches') continue;
      const pat = String(c.pattern ?? '').trim();
      if (!pat) continue;
      if (pat.length >= 2 && pat.startsWith('/') && pat.endsWith('/')) continue;
      if (/^https?:\/\//i.test(pat)) return pat;
    }
    return null;
  };
  // Preference order:
  //   1. preconditions.url_matches — the captured start state. Most
  //      accurate when the fragment was authored with proper precondition
  //      capture (the common case: _capturePreconditions runs at mount
  //      against the live page URL).
  //   2. postconditions.url_matches — captured end state. v2.74.185:
  //      promoted above startUrl in the fallback chain because for
  //      fragments that DON'T navigate the top frame (e.g. interact
  //      only in same-origin iframes), post-state URL equals the
  //      operating URL — and that's where we need to navigate to
  //      replay the fragment. Putting startUrl second hit the stale-
  //      ground-default trap: startUrl captures the ground's default
  //      (e.g. https://app.hubspot.com/) which is where the tab opened
  //      AT START OF AUTHORING, not where the user navigated TO for
  //      the actual work. For navigating fragments, preconditions is
  //      almost always populated (auto-capture from page URL at mount),
  //      so they hit step 1 and this never matters.
  //   3. startUrl — last-ditch literal. Only used when neither
  //      preconditions nor postconditions has a usable url_matches.
  const pre = findLiteralUrlMatch(fragment.preconditions);
  if (pre) return pre;
  const post = findLiteralUrlMatch(fragment.postconditions);
  if (post) return post;
  if (fragment.startUrl && /^https?:\/\//i.test(fragment.startUrl)) {
    return fragment.startUrl;
  }
  return null;
}

/**
 * v2.74.23 — Resolve when a tab finishes loading after a navigation.
 * Used by RUN_ANTECEDENT_FOR_AUTHORING to ensure the page is in its
 * loaded state before the antecedent's actions execute.
 */
function _waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch {}
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };
    const listener = (changedTabId, info) => {
      if (changedTabId === tabId && info.status === 'complete') finish(null);
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Also check current state; tab may already be 'complete' if the
    // navigation finished before we attached the listener.
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        finish(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tab?.status === 'complete') finish(null);
    });
    const timer = setTimeout(() => finish(new Error(`tab ${tabId} did not reach 'complete' within ${timeoutMs}ms`)), timeoutMs);
  });
}

Logger.info('background', 'Agent HUB service worker starting');

chrome.action.onClicked.addListener((tab) => {
  Logger.debug('background', `Action clicked on tab ${tab.id}`);
  // v2.74.984 — icon-click launches the CHAT side panel directly (no popup launcher; fires only because
  // the manifest sets no action.default_popup). chrome.sidePanel.open() MUST run on the LIVE user
  // gesture — i.e. as the FIRST statement, BEFORE any await. The .983 version awaited setOptions/
  // getOptions first, which CONSUMED the gesture token, so open() ran gesture-less, threw, and (last
  // line of an async listener, no catch) failed SILENTLY → clicking the icon did nothing. So: open
  // SYNCHRONOUSLY here. The global default is already chat.html (manifest side_panel.default_path,
  // window-scoped per v2.74.966), so the common case opens chat with no setup needed.
  const openArg = tab?.windowId != null ? { windowId: tab.windowId } : { tabId: tab.id };
  chrome.sidePanel.open(openArg).catch((e) => Logger.warn('background', `sidePanel.open (action click) failed: ${e?.message}`));
  // Path hygiene runs AFTER the gesture-sensitive open (fire-and-forget) — it only displaces a STALE
  // per-tab capture/debug pin for the NEXT open, which is the rare case; never gates this click.
  (async () => {
    try {
      await chrome.sidePanel.setOptions({ path: 'chat.html', enabled: true });
      if (tab?.id != null) {
        const cur = await chrome.sidePanel.getOptions({ tabId: tab.id });
        if (cur?.path && cur.path !== 'chat.html') {
          await chrome.sidePanel.setOptions({ tabId: tab.id, path: 'chat.html', enabled: true });
        }
      }
    } catch { /* setOptions/getOptions unavailable — the global default wins */ }
  })();
});

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ CapabilityAPI event bridge                                               ║
// ║ Subscribe to all CapabilityAPI events and broadcast them to the side     ║
// ║ panel via chrome.runtime.sendMessage so the chat UI can receive them.    ║
// ╚══════════════════════════════════════════════════════════════════════════╝
CapabilityAPI.subscribe((event) => {
  chrome.runtime.sendMessage({
    type   : 'CAPABILITY_EVENT',
    payload: event,
  }).catch(() => { /* side panel may not be open */ });
});

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ v2.44.0 — MV3 service-worker keep-alive while invocations are running.   ║
// ║                                                                          ║
// ║ Background service workers in MV3 unload after ~30s of inactivity. The   ║
// ║ in-memory CapabilityAPI invocation registry dies with them. If a cold    ║
// ║ side panel boots after the worker has cycled, GET_ACTIVE_DEBUG_INVOCATION║
// ║ asks a fresh worker that has no registry — returns null — and the        ║
// ║ debugger sits at idle even though a strategy is running.                 ║
// ║                                                                          ║
// ║ Fix: track the set of in-flight invocations and ping a cheap async       ║
// ║ Chrome API every 20s while the set is non-empty. The ping resets the     ║
// ║ worker's idle timer. When the last invocation finishes, the interval     ║
// ║ clears and the worker is free to unload normally.                        ║
// ║                                                                          ║
// ║ Set (not counter) so duplicate events are idempotent.                    ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const __activeInvocations = new Set();
let __keepAliveInterval = null;

// (the workflow cancellation/debug state + broadcasts lived here until v2.74.953 — CR-X3c moved them with the domain.)

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ v2.72.41 (Pass 17g) — Pending perspective capture session.                    ║
// ║                                                                          ║
// ║ When studio's Perspective form clicks "Open in debugger to capture", studio   ║
// ║ hands off the perspective draft (name + description + urlPattern + landmark   ║
// ║ roles) to background, which opens the URL tab + debugger sidepanel,     ║
// ║ stores the draft here, and the debugger queries it on boot to enter     ║
// ║ perspective-capture mode.                                                     ║
// ║                                                                          ║
// ║ At most one session at a time (single sidepanel can't host two flows).  ║
// ║ Cleared on COMMIT (after debugger saves) or CANCEL (user dismisses).    ║
// ║ Survives service-worker restarts only as long as background stays warm; ║
// ║ a long pause that puts background to sleep loses the session, which is  ║
// ║ acceptable for v1 (user starts over from studio).                        ║
// ╚══════════════════════════════════════════════════════════════════════════╝
let __pendingPerspectiveCapture = null;  // { draft, tabId, sessionId, startedAt }

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ v2.72.50 (Stage 1) — Sidepanel mode registry.                            ║
// ║                                                                          ║
// ║ Single source of truth for "what mode is the sidepanel showing right     ║
// ║ now." Modes are mutually exclusive. Setting a new mode unmounts the      ║
// ║ previous one (the sidepanel shell handles the unmount; background just   ║
// ║ tracks the state and broadcasts changes).                                ║
// ║                                                                          ║
// ║ Messages:                                                                ║
// ║   GET_SIDEPANEL_MODE        — shell asks on cold boot                    ║
// ║   REQUEST_SIDEPANEL_MODE    — caller asks to switch                      ║
// ║   SIDEPANEL_MODE_CHANGED    — broadcast after change (for the shell)     ║
// ║                                                                          ║
// ║ Mode and runtime are separate concerns: an active strategy invocation    ║
// ║ runs in background regardless of whether the sidepanel is in            ║
// ║ strategy-debug mode. The mode is just the visual surface.                ║
// ╚══════════════════════════════════════════════════════════════════════════╝
let __sidepanelMode = null;          // null | 'chat' | 'strategy-debug' | 'perspective-capture' | ...
let __sidepanelModePayload = null;   // mode-specific payload (e.g. {groundId} for perspective-capture)

function __setSidepanelMode(mode, payload = null) {
  __sidepanelMode = mode;
  __sidepanelModePayload = payload;
  Logger.info('background', `Sidepanel mode set: ${mode ?? '(idle)'}`);

  // Broadcast — the shell listens and updates the UI.
  chrome.runtime.sendMessage({
    type: 'SIDEPANEL_MODE_CHANGED',
    payload: { mode, payload },
  }).catch(() => { /* no listeners is fine */ });
}

// v2.74.128 — Dead-code removal.
//
// Per-tab sidepanel mode tracking previously lived here in background as
// `__tabSidepanelModes`. The v2.74.55 shell.js refactor moved the
// authoritative map into the sidepanel page itself (`_tabModes` in
// shell.js), since the SW dies on idle and would lose its records,
// while the sidepanel page outlives the SW. The background map kept
// being written to (by __setSidepanelMode and by the
// BEGIN_FRAGMENT_AUTHOR / BEGIN_OBSERVATION_AUTHOR setup-result paths)
// but never read by anyone — GET_TAB_SIDEPANEL_MODE had zero external
// callers (verified via codebase grep at v2.74.127).
//
// Removed:
//   - `__tabSidepanelModes` map declaration + onRemoved cleanup
//   - The if/else in __setSidepanelMode that wrote to it
//   - The BEGIN_FRAGMENT_AUTHOR / BEGIN_OBSERVATION_AUTHOR setup-result
//     writes that tried to update the resolved tabId post-hoc
//   - The GET_TAB_SIDEPANEL_MODE handler (no callers)
//   - The CLEAR_TAB_SIDEPANEL_MODE handler in background (the shell's
//     handler in Sidepanel/shell.js does the actual work)
//
// The shell's `_tabModes` + its `chrome.tabs.onRemoved` cleanup
// (added in v2.74.127) is now the single source of truth.

function __startKeepAlive() {
  if (__keepAliveInterval) return;
  // 20s — comfortably under Chrome's 30s idle threshold.
  __keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => { /* return value unused — call alone resets idle */ });
  }, 20_000);
  Logger.debug('background', 'keep-alive started');
}

// v2.72.41 (Pass 17g) — Perspective-capture tab-finder. Mirrors PageProbe's
// findOrOpenTab but lives in background so we don't have to import a
// service module from the message dispatcher. Same pattern semantics:
// substring/regex match against existing tabs first, then open https://
// for domain-shaped patterns.
async function __findOrOpenTabForPerspective(urlPattern) {
  if (!urlPattern || typeof urlPattern !== 'string') {
    return { ok: false, error: 'urlPattern required' };
  }
  const matcher = __compilePattern(urlPattern);
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return { ok: false, error: `chrome.tabs.query failed: ${e.message}` };
  }
  const existing = tabs.find(t => t?.url && matcher(t.url));
  if (existing) {
    try { await chrome.tabs.update(existing.id, { active: true }); } catch { /* best-effort */ }
    if (Number.isFinite(existing.windowId)) {
      try { await chrome.windows.update(existing.windowId, { focused: true }); } catch { /* best-effort */ }
    }
    return { ok: true, tabId: existing.id, url: existing.url };
  }
  // Open new tab. Auto-prefix domain-shaped patterns to https://.
  let candidateUrl = /^https?:\/\//i.test(urlPattern) ? urlPattern : null;
  if (!candidateUrl && __looksLikeDomain(urlPattern)) {
    candidateUrl = `https://${urlPattern}`;
  }
  if (!candidateUrl) {
    return {
      ok: false,
      error: `No tab matches "${urlPattern}", and the pattern isn't openable as a URL. Open a matching tab first, or use a full URL like "https://example.com".`,
    };
  }
  let newTab;
  try {
    newTab = await chrome.tabs.create({ url: candidateUrl, active: true });
  } catch (e) {
    return { ok: false, error: `chrome.tabs.create failed: ${e.message}` };
  }
  return { ok: true, tabId: newTab.id, url: candidateUrl };
}
function __compilePattern(pattern) {
  const looksLikeRegex = pattern.length > 2
    && pattern.startsWith('/') && pattern.endsWith('/')
    && !/\s/.test(pattern.slice(1, -1));
  if (looksLikeRegex) {
    try {
      const re = new RegExp(pattern.slice(1, -1));
      return (url) => re.test(url);
    } catch { /* fall through to substring */ }
  }
  return (url) => url.includes(pattern);
}
function __looksLikeDomain(s) {
  if (typeof s !== 'string' || !s) return false;
  if (s.startsWith('/')) return false;
  if (/\s/.test(s)) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/.*)?$/i.test(s);
}

/**
 * v2.72.44 — Wait for a tab to reach status='complete'. Resolves on
 * complete, on error, or on timeout (resolves regardless — caller treats
 * timeout as "best effort" and proceeds). Used after chrome.tabs.create
 * to gate content-script re-injection until the page is past document_start.
 */
async function __waitForTabComplete(tabId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const timer = setTimeout(finish, timeoutMs);

    // If the tab is already complete, resolve immediately.
    chrome.tabs.get(tabId).then(t => {
      if (t?.status === 'complete') { clearTimeout(timer); finish(); }
    }).catch(() => { clearTimeout(timer); finish(); });

    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId !== tabId) return;
      if (info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// (the in-tab sitemap fetcher lived here until v2.74.952 — CR-X3b moved it with the discovery domain.)

/**
 * v2.72.72 — Execute a CLICK action with navigation/new-tab observation.
 *
 * A CLICK can produce three outcomes:
 *   1. Pure DOM click — content script returns success normally.
 *   2. Same-tab navigation — page unloads mid-execute. The content
 *      script's response may not arrive (the message channel dies with
 *      the page) and we'd otherwise score the action as failed even
 *      though the click clearly worked.
 *   3. New-tab open — click opens a new tab via target=_blank or
 *      window.open. The content script returns success but the user
 *      may want the action verified based on tab observation, not just
 *      the DOM click landing.
 *
 * To handle (2) and (3) correctly, we register chrome.webNavigation +
 * chrome.tabs.onCreated listeners scoped to this tabId BEFORE
 * dispatching the EXECUTE_STEP. We then race the EXECUTE_STEP response
 * against either listener firing within an observation window. If either
 * fires, we treat the click as successful — the click DID something
 * observable, even if the content-script response was lost.
 *
 * Listeners are always cleaned up (success path or error path).
 *
 * @param {number} tabId
 * @param {Object} step  - {action: 'CLICK', selector, value, ...}
 * @returns {Promise<{success: boolean, error?: string, info?: string}>}
 */
async function __executeClickWithNavObservation(tabId, step, frameId = 0) {
  const OBSERVATION_WINDOW_MS = 3000;
  let navObserved = null;       // 'same-tab' | 'new-tab' | null
  let newTabId = null;
  let newTabUrl = null;

  // Same-tab navigation listener. transitionType='link' or 'manual_subframe'
  // is the typical click-induced transition. We accept any committed
  // navigation on this tabId during the observation window.
  //
  // v2.74.163 — Frame-aware. When the click is dispatched into an
  // iframe (frameId !== 0), navigation events fire on EITHER the
  // iframe (same-tab subframe nav) OR the top frame (the iframe's
  // click opened a top-level link via target=_top etc.). Accept both —
  // the click "succeeded" in either case.
  const onCommitted = (details) => {
    if (details.tabId !== tabId) return;
    if (details.frameId !== 0 && details.frameId !== frameId) return;
    if (navObserved) return;             // first wins
    navObserved = 'same-tab';
    newTabUrl = details.url;
  };
  chrome.webNavigation.onCommitted.addListener(onCommitted);

  // New-tab listener. We filter to tabs whose openerTabId matches our tab,
  // which covers target=_blank link clicks and window.open() spawns.
  const onTabCreated = (tab) => {
    if (tab.openerTabId !== tabId) return;
    if (navObserved) return;
    navObserved = 'new-tab';
    newTabId = tab.id;
    newTabUrl = tab.pendingUrl ?? tab.url ?? null;
  };
  chrome.tabs.onCreated.addListener(onTabCreated);

  const cleanup = () => {
    try { chrome.webNavigation.onCommitted.removeListener(onCommitted); } catch {}
    try { chrome.tabs.onCreated.removeListener(onTabCreated); } catch {}
  };

  // Dispatch the actual click. Content script returns success/failure
  // synchronously after the click event fires. If the page unloads
  // mid-click, this rejects with "channel disconnected" or similar.
  // v2.72.91 — Use step.action (CLICK or CLICK_BY_LABEL) so the content
  // script dispatches to the right handler. CLICK_BY_LABEL's value
  // carries the option label; same nav-observation rescue applies if
  // the option click navigates.
  let stepResult = null;
  let stepError = null;
  try {
    stepResult = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, {
        type: 'EXECUTE_STEP',
        payload: {
          action: step.action,
          selector: step.selector,
          value: step.value,
          smoothScroll: false,
        },
      }, { frameId }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
  } catch (e) {
    stepError = e.message;
  }

  // Wait the remainder of the observation window for navigation to settle.
  // (Some clicks dispatch the event but the framework doesn't commit
  // navigation until microtasks finish.) If a nav was already observed,
  // shorten the wait — we have what we need.
  const waitMs = navObserved ? 200 : OBSERVATION_WINDOW_MS;
  await new Promise(r => setTimeout(r, waitMs));
  cleanup();

  // Decide success.
  if (stepResult?.success) {
    // Content script confirmed click. Append nav info if observed.
    const info = navObserved
      ? (navObserved === 'new-tab'
          ? `clicked, opened new tab${newTabUrl ? ` → ${newTabUrl}` : ''}`
          : `clicked, navigated${newTabUrl ? ` → ${newTabUrl}` : ''}`)
      : (stepResult.info ?? null);
    return { success: true, info };
  }
  if (navObserved) {
    // Content script response was lost (page unloaded), but a navigation
    // happened — the click did something observable. Treat as success.
    Logger.info('background',
      `CLICK content-script response missing but ${navObserved} observed${newTabUrl ? ` → ${newTabUrl}` : ''} — treating as success`);
    const info = navObserved === 'new-tab'
      ? `clicked, opened new tab${newTabUrl ? ` → ${newTabUrl}` : ''}`
      : `clicked, navigated${newTabUrl ? ` → ${newTabUrl}` : ''}`;
    return { success: true, info };
  }
  // Neither response success nor navigation observed — the click failed.
  const errMsg = stepResult?.error
    ?? stepError
    ?? 'CLICK returned no response and no navigation observed';
  return { success: false, error: errMsg };
}

function __stopKeepAlive() {
  if (!__keepAliveInterval) return;
  clearInterval(__keepAliveInterval);
  __keepAliveInterval = null;
  Logger.debug('background', 'keep-alive stopped');
}

CapabilityAPI.subscribe((event) => {
  const id = event?.invocationId;
  if (!id) return;
  // Lifecycle events that mean "an invocation is in flight" → add to set
  if (event.type === CAP_EVENT.INVOCATION_STARTED ||
      event.type === CAP_EVENT.INVOCATION_QUEUED) {
    __activeInvocations.add(id);
    if (__activeInvocations.size === 1) __startKeepAlive();
    return;
  }
  // Lifecycle events that mean "this invocation is done" → remove from set
  if (event.type === CAP_EVENT.INVOCATION_COMPLETED ||
      event.type === CAP_EVENT.INVOCATION_FAILED ||
      event.type === CAP_EVENT.INVOCATION_CANCELLED) {
    __activeInvocations.delete(id);
    if (__activeInvocations.size === 0) __stopKeepAlive();
    return;
  }
});

// v2.71.4 — Toolbar badge + conversation persistence subscriber.
// v2.71.6 — Animated icon pulse replaces static badge for "live" indication.
//
// Two responsibilities, both kicked off by CapabilityAPI lifecycle events:
//
// 1. Toolbar pulse: when invocations are running, render a pulsing red ring
//    around the base icon glyph via OffscreenCanvas + chrome.action.setIcon.
//    Frame rate 10fps, 1000ms sine-wave cycle. Reads as alive without
//    Chrome's flicker concerns at higher frame rates. Badge text still
//    shows count when >1 invocation is running.
//
// 2. ConversationStore updates: when a terminal event fires for an
//    invocation that has a conversationId (set by chat at invoke time),
//    write a result message to ConversationStore. This lets a chat panel
//    that was closed during execution see the completion when reopened.
//    Plain-text body — chat foreground does rich rendering when live, but
//    a plain-text fallback is enough to mark the message as done and
//    preserve the conversation history.

// ── v2.71.6 — Pulse animation state ────────────────────────────────────────
let __pulseInterval = null;
let __pulseStartedAt = 0;
const PULSE_CYCLE_MS = 2000;          // one full sine cycle — slow, calm heartbeat
const PULSE_FRAME_INTERVAL_MS = 200;  // 5fps — half the cycle rate, lower IPC load
const ICON_SIZE = 32;                 // render at 32px and let Chrome scale
                                      // (16px directly looks chunky; 32px scaled
                                      //  down anti-aliases nicely on most displays)
// Pulse color — matches the SCROLL strategy node accent (purple #a78bfa) for
// consistent visual language across the surface.
const PULSE_R = 167, PULSE_G = 139, PULSE_B = 250;

/**
 * Render one frame of the pulse animation as ImageData.
 * @param {number} t - milliseconds elapsed since pulse start
 * @returns {ImageData}
 */
function __renderPulseFrame(t) {
  const canvas = new OffscreenCanvas(ICON_SIZE, ICON_SIZE);
  const ctx = canvas.getContext('2d');
  const cx = ICON_SIZE / 2;
  const cy = ICON_SIZE / 2;

  // Sine wave 0 → 1 → 0 with 1000ms period. Opacity of the pulse ring
  // oscillates between 0.25 (faint) and 1.0 (full).
  const phase = (t % PULSE_CYCLE_MS) / PULSE_CYCLE_MS;   // 0..1
  const wave = (Math.sin(phase * Math.PI * 2 - Math.PI / 2) + 1) / 2;  // 0..1
  const ringOpacity = 0.25 + 0.75 * wave;
  const ringRadius = 12 + wave * 2;   // subtle radius pulse too: 12..14

  // Background — transparent
  ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);

  // Outer pulse ring — purple accent, glowing
  ctx.strokeStyle = `rgba(${PULSE_R}, ${PULSE_G}, ${PULSE_B}, ${ringOpacity})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
  ctx.stroke();

  // Inner solid ring (constant) for definition
  ctx.strokeStyle = `rgba(${PULSE_R}, ${PULSE_G}, ${PULSE_B}, 0.9)`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, 9, 0, Math.PI * 2);
  ctx.stroke();

  // Center glyph — diamond (◈) suggesting "active node"
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(cx, cy - 5);
  ctx.lineTo(cx + 5, cy);
  ctx.lineTo(cx, cy + 5);
  ctx.lineTo(cx - 5, cy);
  ctx.closePath();
  ctx.fill();

  // Hollow center dot for the "diamond eye" detail
  ctx.fillStyle = `rgba(${PULSE_R}, ${PULSE_G}, ${PULSE_B}, 0.9)`;
  ctx.beginPath();
  ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
  ctx.fill();

  return ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE);
}

function __startPulse() {
  if (__pulseInterval) return;
  __pulseStartedAt = Date.now();
  // Render first frame immediately so the pulse appears instantly.
  __tickPulse();
  __pulseInterval = setInterval(__tickPulse, PULSE_FRAME_INTERVAL_MS);
  Logger.debug('background', 'icon pulse started');
}

function __tickPulse() {
  try {
    const t = Date.now() - __pulseStartedAt;
    const imageData = __renderPulseFrame(t);
    chrome.action.setIcon({ imageData });
  } catch (err) {
    Logger.warn('background', `pulse frame render failed: ${err.message}`);
    __stopPulse();
  }
}

function __stopPulse() {
  if (__pulseInterval) {
    clearInterval(__pulseInterval);
    __pulseInterval = null;
  }
  // Restore the static manifest icon. Chrome accepts a path-dictionary
  // here. Falls back to manifest icons if this call fails for any reason.
  try {
    chrome.action.setIcon({
      path: {
        '16': 'assets/icon16.png',
        '48': 'assets/icon48.png',
        '128': 'assets/icon128.png',
      },
    });
  } catch (err) {
    Logger.warn('background', `restore static icon failed: ${err.message}`);
  }
  Logger.debug('background', 'icon pulse stopped');
}

function __updateToolbarBadge() {
  const count = __activeInvocations.size;
  try { chrome.storage.session.set({ 'badge:invocations': count }).catch?.(() => {}); } catch { /* CF-2.6 — cadence defers its paint while this is >0 */ }
  try {
    if (count === 0) {
      // CF-2.6 (chat-tab review) — the empty-set clear used to WIPE cadence's standing '!'/'✓' badge with no
      // re-assert; now the recorded cadence state (chrome.storage.session, SW-teardown-proof) restores instead.
      (async () => {
        let rec = null;
        try { rec = (await chrome.storage.session.get('badge:cadence'))?.['badge:cadence'] || null; } catch { /* */ }
        try {
          if (rec && rec.text) {
            chrome.action.setBadgeText({ text: rec.text });
            if (rec.color) chrome.action.setBadgeBackgroundColor({ color: rec.color });
            if (rec.title) chrome.action.setTitle({ title: rec.title });
          } else {
            chrome.action.setBadgeText({ text: '' });
          }
        } catch { /* */ }
      })();
      __stopPulse();
    } else {
      // Show count badge only when >1 invocation. Single invocation gets
      // just the pulsing icon — cleaner read.
      chrome.action.setBadgeText({ text: count === 1 ? '' : String(count) });
      chrome.action.setBadgeBackgroundColor({ color: '#a78bfa' });    // purple, matches pulse
      if (chrome.action.setBadgeTextColor) {
        chrome.action.setBadgeTextColor({ color: '#ffffff' }).catch?.(() => {});
      }
      __startPulse();
    }
  } catch (err) {
    // Badge/icon updates are best-effort; never let them break invocation flow.
    Logger.warn('background', `setBadgeText/Icon failed: ${err.message}`);
  }
}

async function __persistTerminalEventToConversation(event) {
  const invocationId = event?.invocationId;
  if (!invocationId) return;

  // Look up the invocation to get conversationId. Snapshot may have been
  // cleaned up if this fires very late; tolerate that.
  const snap = CapabilityAPI.getInvocation(invocationId);
  const conversationId = snap?.conversationId ?? null;
  if (!conversationId) return;   // not a chat invocation; nothing to persist

  // Race-avoidance: if chat is open, its handleInvocationCompleted (and
  // siblings) already persisted a rich-HTML message synchronously. Don't
  // clobber that with our plain-text fallback. Detect by reading the
  // current conversation: if a message with this invocationId exists AND
  // its role isn't 'thinking' (i.e. a chat handler already finalized it),
  // skip our write.
  let conv;
  try {
    conv = await ConversationStore.load(conversationId);
  } catch (err) {
    Logger.warn('background', `ConversationStore.load failed for ${conversationId}: ${err.message}`);
    return;
  }
  if (!conv) return;

  const messageId = `msg-${invocationId}`;
  const existing = (conv.messages ?? []).find(m => m.id === messageId);
  // v2.71.10 (Bug J cleanup) — If a message exists in the persisted store
  // with this invocationId, chat foreground already finalized it with rich
  // rendering. Don't clobber. ConversationStore never persists 'thinking'
  // role messages (chat skips them per persistence rules in appendMessage),
  // so any message we find here is a finalized assistant/system message.
  if (existing) {
    return;
  }

  // v2.71.10 (Bug L cleanup) — Clean up declaration. role is constant;
  // body and outcome are assigned in every branch.
  const role = 'assistant';
  let body, outcome;
  if (event.type === CAP_EVENT.INVOCATION_COMPLETED) {
    const stepResults = Array.isArray(event.result?.stepResults) ? event.result.stepResults : [];
    const ran = stepResults.filter(r => r.success && !r.skipped).length;
    const skipped = stepResults.filter(r => r.skipped).length;
    const failed = stepResults.filter(r => !r.success).length;
    if (stepResults.length === 0) {
      body = `${snap.capabilityName ?? 'Task'} completed.`;
      outcome = { kind: 'success', label: 'Completed', detail: '' };
    } else if (failed === 0) {
      const skipNote = skipped > 0 ? ` (${skipped} skipped)` : '';
      body = `${snap.capabilityName ?? 'Task'} completed — ${ran + skipped}/${stepResults.length} step${stepResults.length === 1 ? '' : 's'}${skipNote}.`;
      outcome = { kind: 'success', label: 'Completed', detail: '' };
    } else {
      body = `${snap.capabilityName ?? 'Task'} — ${ran + skipped}/${stepResults.length} step${stepResults.length === 1 ? '' : 's'} succeeded.`;
      outcome = { kind: 'partial', label: 'Partial', detail: `${failed} failed` };
    }
  } else if (event.type === CAP_EVENT.INVOCATION_FAILED) {
    body = `${snap.capabilityName ?? 'Task'} failed.`;
    outcome = { kind: 'error', label: 'Failed', detail: event.error ?? 'unknown error' };
  } else if (event.type === CAP_EVENT.INVOCATION_CANCELLED) {
    body = `${snap.capabilityName ?? 'Task'} was cancelled.`;
    outcome = { kind: 'cancelled', label: 'Cancelled', detail: '' };
  } else {
    return;
  }

  try {
    await ConversationStore.updateMessage(conversationId, messageId, {
      id: messageId,
      role,
      body,
      ts: Date.now(),
      invocationId,
      attribution: snap.capabilityName ?? '',
      outcome,
    });
  } catch (err) {
    // Conversation may not exist (deleted before completion); not fatal.
    Logger.warn('background', `ConversationStore update failed for ${invocationId}: ${err.message}`);
  }
}

CapabilityAPI.subscribe((event) => {
  // Update badge on every lifecycle event (the activeInvocations set was
  // updated by the earlier subscriber).
  if (event.type === CAP_EVENT.INVOCATION_STARTED ||
      event.type === CAP_EVENT.INVOCATION_QUEUED ||
      event.type === CAP_EVENT.INVOCATION_COMPLETED ||
      event.type === CAP_EVENT.INVOCATION_FAILED ||
      event.type === CAP_EVENT.INVOCATION_CANCELLED) {
    __updateToolbarBadge();
  }

  // v2.71.10 (Bug K+M fix) — Persist terminal events synchronously rather
  // than via setTimeout. Pre-v2.71.10 a 500ms delay was added under the
  // theory that chat foreground's rich-HTML write should win the race when
  // the panel is open. But the existing-message check inside
  // __persistTerminalEventToConversation is the authoritative race guard;
  // the delay was paranoia. Worse, the delay created a ghost-failure
  // scenario: if the user reopened the panel within 500ms of a terminal
  // event, the resume logic's listInvocations({status:'running'}) returned
  // empty (the invocation was already terminal in CapabilityAPI), and our
  // delayed setTimeout hadn't fired yet, so no bubble was synthesized AND
  // no terminal message was persisted in time for rehydration. The user
  // saw nothing — the strategy result was effectively lost until reload.
  // Fire-and-forget the async write directly.
  if (event.type === CAP_EVENT.INVOCATION_COMPLETED ||
      event.type === CAP_EVENT.INVOCATION_FAILED ||
      event.type === CAP_EVENT.INVOCATION_CANCELLED) {
    __persistTerminalEventToConversation(event).catch(err => {
      Logger.warn('background', `terminal-event persistence failed: ${err.message}`);
    });
  }
});

// v2.74.231/392 — URL normalizer (origin + pathname; strips query/fragment) for
// per-(ground, page) caches. Originally for the now-removed perspective auto-discovery
// cache; retained because the pageStructure cache + resolve knownSelectors reuse
// it. (The perspectiveAutoDiscoveryCache + its read/write helpers were removed with
// the legacy auto-suggest feature.)
function _normalizeUrlForPerspectiveCache(url) {
  return GroundAssetStore.normalizeLocaleKey(url);
}

// v2.74.427 — #2 P5: the pageStructure artifact cache is retired. The "+ Perspective"
// depth sweep still runs (EXPLORE_PAGE_STRUCTURE) and its in-memory `structure` is
// folded into the Locale (mergeDepthFromControls); only the Locale is persisted.

const LOCALE_CACHE_KEY = GroundAssetStore.LOCALE_CACHE_KEY;
const LOCALE_TTL_MS = GroundAssetStore.LOCALE_TTL_MS;

async function _readLocaleCache(groundId, cacheKey) {
  return GroundAssetStore.readLocale(groundId, cacheKey);
}

async function _writeLocaleCache(groundId, cacheKey, entry) {
  await GroundAssetStore.writeLocale(groundId, cacheKey, entry);
}

// v2.74.446 — navigate a tab and resolve when it reports 'complete' (cross-locale
// label harvest drives the queue's tab to each language's exemplar).
const MAX_HARVEST_OTHER_LOCALES = 4;   // extra languages enumerated per archetype
function _navigateBgTab(tabId, url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { chrome.tabs.onUpdated.removeListener(l); reject(new Error('navigation timeout')); }, timeoutMs);
    const l = (id, info) => { if (id === tabId && info.status === 'complete') { clearTimeout(to); chrome.tabs.onUpdated.removeListener(l); resolve(); } };
    chrome.tabs.onUpdated.addListener(l);
    chrome.tabs.update(tabId, { url }).catch((e) => { clearTimeout(to); chrome.tabs.onUpdated.removeListener(l); reject(e); });
  });
}

// v2.74.413 — OUTCOMES slice 2: the ONE unified append-only stream (OUTCOMES_SPEC
// § 1, GROUND_SPEC § 0.13). Authoring + runtime events land here once; the small
// artifact rollups (Feature.health / Perspective.usage / Ground.conventions) are
// FOLDED on read, never authored. Bounded so the store can't grow without limit;
// the durable training corpus body is a later exporter slice (§ 0.17).
//   key: 'outcomesStream'   value: { [groundId]: OutcomeEvent[] }
// v2.74.463 — PER-GROUND storage keys. The old scheme kept ALL grounds in one aggregate
// object under a single key (`siteMapCache`/`outcomesStream` → { [groundId]: … }), so every
// merge/append rewrote the entire multi-ground blob — O(all grounds) per write, and one
// oversized item (a factor in the kQuotaBytes failures). Now each ground's siteMap / outcome
// stream is its own key, so a write touches only that ground. The two legacy aggregate keys
// are migrated away once (see _migrateAggregates) and then never written again.
const OUTCOMES_STREAM_KEY = 'outcomesStream';   // legacy aggregate (pre-v463) — migrated away
const SITEMAP_CACHE_KEY   = 'siteMapCache';     // legacy aggregate (pre-v463) — migrated away
const OUTCOMES_STREAM_CAP = 1000;               // per ground; oldest dropped (appendEvents)
const _siteMapKey  = (groundId) => `siteMap:${groundId}`;
const _outcomesKey = (groundId) => `outcomes:${groundId}`;

// One-time, idempotent migration of the legacy aggregates → per-ground keys. Gated behind a
// shared promise so every accessor awaits it exactly once. Safety: write the new keys FIRST,
// remove the old aggregate only AFTER (a mid-migration failure never loses data), and never
// clobber an existing per-ground key (re-runs are no-ops; a concurrent fresh write wins).
let _storageMigration = null;
function _ensureStorageMigrated() { return (_storageMigration ??= GroundAssetStore.ensureStorageMigrated()); }

async function _appendOutcomes(groundId, events) {
  if (!groundId || !Array.isArray(events) || !events.length) return;
  await _ensureStorageMigrated();
  try {
    const k = _outcomesKey(groundId);
    const got = await chrome.storage.local.get(k);
    const next = Outcomes.appendEvents(got?.[k] ?? [], events, OUTCOMES_STREAM_CAP);
    await chrome.storage.local.set({ [k]: next });
  } catch (e) {
    Logger.warn('background', `outcomes append failed: ${e.message}`);
  }
}

// ── SG-5 / PB-7 acceptance persistence ─────────────────────────────────────────
// Copy-on-accept (DESIGN_substrate_grounded_capabilities §SG-5): a passing RUN_SG_TRIAL leaves a SESSION
// DRAFT (in chrome.storage.session, so it survives an MV3 service-worker unload during the user's review);
// ACCEPT_SG_TRIAL materializes it into a LEAN capability (chrome.storage.local, per-ground, sync-ready by
// shape) + a HEAVY trialTrace (local, by trialRef — runtime/training, never authoring-synced); REJECT drops
// the draft. Direct chrome.storage.local writes bypass the sync bridge for now (partition/sync wiring is a
// later slice); the lean record's shape is already the workspace primitive.
const _sgCapKey = (groundId) => `sgCapabilities:${groundId}`;
const _sgTraceKey = (trialRef) => `sgTrialTrace:${trialRef}`;
const _sgDraftKey = (groundId) => `sgTrialDraft:${groundId}`;
const SG_CAP_CAP = 200;   // per-ground capability cap (newest kept)

async function _readSgCapabilities(groundId) {
  if (!groundId) return [];
  try { const k = _sgCapKey(groundId); const got = await chrome.storage.local.get(k); return Array.isArray(got?.[k]) ? got[k] : []; }
  catch { return []; }
}
// v2.74.932 (CR-ST2) — per-ground WRITE CHAIN for the sgCapabilities array. Every writer rewrites the
// whole array from a private read: the chat fires ORCH_RECORD_ALIAS unawaited per walk step while REPLAY's
// self-heal prunes — an alias write whose snapshot predated the prune RESURRECTED the just-deleted orphan.
// Chained per ground (the Logger #persistTail pattern); reads inside the chain see the prior write.
const _sgCapChains = new Map();
function _sgCapChained(groundId, fn) {
  const tail = _sgCapChains.get(groundId) || Promise.resolve();
  const next = tail.then(() => fn());
  const stored = next.catch(() => {});
  _sgCapChains.set(groundId, stored);
  stored.then(() => { if (_sgCapChains.get(groundId) === stored) _sgCapChains.delete(groundId); });
  return next;
}
// Upsert by capability id (a re-accept of the same (ground,locale,intent) replaces the prior record).
async function _writeSgCapability(groundId, cap) {
  if (!groundId || !cap?.id) return;
  return _sgCapChained(groundId, async () => {   // v2.74.932 (CR-ST2)
    const k = _sgCapKey(groundId);
    const list = await _readSgCapabilities(groundId);
    const next = [cap, ...list.filter((c) => c.id !== cap.id)].slice(0, SG_CAP_CAP);
    await chrome.storage.local.set({ [k]: next });
  });
}

// §18 (v2.74.1268) — the per-Ground RIDE-RECIPE collection (DESIGN_connectors.md). Mirrors the sgCapabilities store: a
// per-ground array in chrome.storage.local, serialized by an RMW chain (CR-ST2). Seeded from CONNECTOR_RECIPES on first
// access (in the GET handler, which knows the origin); harvested/demonstrated recipes accrete here (§17). The pure model
// + the safety transforms live in Core/rideRecipe.js; the arm guard (armable) gates execution at the dispatch (slice 6).
const _rideRecipesKey = (groundId) => `rideRecipes:${groundId}`;
const RIDE_RECIPE_CAP = 300;
async function _readRideRecipes(groundId) {
  if (!groundId) return [];
  try { const k = _rideRecipesKey(groundId); const got = await chrome.storage.local.get(k); return Array.isArray(got?.[k]) ? got[k] : []; }
  catch { return []; }
}
const _rideRecipeChains = new Map();
function _rideRecipeChained(groundId, fn) {
  const tail = _rideRecipeChains.get(groundId) || Promise.resolve();
  const next = tail.then(() => fn());
  const stored = next.catch(() => {});
  _rideRecipeChains.set(groundId, stored);
  stored.then(() => { if (_rideRecipeChains.get(groundId) === stored) _rideRecipeChains.delete(groundId); });
  return next;
}
// Replace the whole per-ground list (handlers compute the next list with the PURE rideRecipe transforms, then persist).
async function _writeRideRecipes(groundId, list) {
  if (!groundId) return;
  return _rideRecipeChained(groundId, async () => {
    await chrome.storage.local.set({ [_rideRecipesKey(groundId)]: (Array.isArray(list) ? list : []).slice(0, RIDE_RECIPE_CAP) });
  });
}

// HL-1 (v2.74.1454) — the per-Ground DRIVE-ARTIFACT collection (built-in drive twins of the ride recipes;
// Core/driveArtifacts.js). Mirrors the rideRecipes store exactly: per-ground array, chained RMW, seeded from
// DRIVE_ARTIFACTS on first access (in the sg.js merged read, which knows the origin). Hydration stamps
// (capabilityId/fragmentId/strategyId) live ON these records so a catalog re-seed never orphans them.
const _driveArtifactsKey = (groundId) => `driveArtifacts:${groundId}`;
const DRIVE_ARTIFACT_CAP = 100;
async function _readDriveArtifacts(groundId) {
  if (!groundId) return [];
  try { const k = _driveArtifactsKey(groundId); const got = await chrome.storage.local.get(k); return Array.isArray(got?.[k]) ? got[k] : []; }
  catch { return []; }
}
const _driveArtifactChains = new Map();
function _driveArtifactChained(groundId, fn) {
  const tail = _driveArtifactChains.get(groundId) || Promise.resolve();
  const next = tail.then(() => fn());
  const stored = next.catch(() => {});
  _driveArtifactChains.set(groundId, stored);
  stored.then(() => { if (_driveArtifactChains.get(groundId) === stored) _driveArtifactChains.delete(groundId); });
  return next;
}
async function _writeDriveArtifacts(groundId, list) {
  if (!groundId) return;
  return _driveArtifactChained(groundId, async () => {
    await chrome.storage.local.set({ [_driveArtifactsKey(groundId)]: (Array.isArray(list) ? list : []).slice(0, DRIVE_ARTIFACT_CAP) });
  });
}

// PS-0 (v2.74.1123) — the per-Ground capability-gap registry: Orchard's "how could you do better?" enumeration,
// PERSISTED (durable chrome.storage.local) instead of discarded. The inverse of a Perspective; PS-1 arms it into
// the interaction monitor so the user's ordinary actions passively fulfil + learn the gaps. (DESIGN_passive_synthesis §2.1)
const _gapsKey = (groundId) => `gaps:${groundId}`;
async function _readGaps(groundId) {
  if (!groundId) return [];
  try { const k = _gapsKey(groundId); const got = await chrome.storage.local.get(k); return deserializeGaps(got?.[k]); }
  catch { return []; }
}
// PS-1 — per-Ground gaps RMW CHAIN (CR-ST2 pattern). IL_ANSWER's enumerate-merge and the monitor's passive
// harvest are BOTH read-modify-writers of gaps:<groundId>; serialize them per Ground so a click-harvest can't
// clobber a concurrent re-enumeration (or vice versa) with a stale snapshot.
const _gapsChains = new Map();
function _gapsChained(groundId, fn) {
  const tail = _gapsChains.get(groundId) || Promise.resolve();
  const next = tail.then(() => fn());
  const stored = next.catch(() => {});
  _gapsChains.set(groundId, stored);
  stored.then(() => { if (_gapsChains.get(groundId) === stored) _gapsChains.delete(groundId); });
  return next;
}
// Read -> apply mutator -> write, atomically per Ground. Skips the write when the mutator returns the SAME array
// (no change) so a no-match harvest costs only a read. Returns the resulting gaps.
async function _mutateGaps(groundId, fn) {
  if (!groundId || typeof fn !== 'function') return [];
  return _gapsChained(groundId, async () => {
    const cur = await _readGaps(groundId);
    let next; try { next = fn(cur); } catch { next = cur; }
    if (next == null || next === cur) return cur;
    try { await chrome.storage.local.set({ [_gapsKey(groundId)]: serializeGaps(next) }); }
    catch (e) { Logger.warn('background', `gaps write failed: ${e.message}`); }
    return next;
  });
}

// PS-2 — the long-tail observed pool (observedPool:<groundId>): unmatched named misses, durably retained as a
// VALUE-FREE catch-net. Its own per-Ground RMW chain (mirrors the gaps chain) so concurrent harvest-misses serialize.
const _obsPoolKey = (groundId) => `observedPool:${groundId}`;
async function _readObsPool(groundId) {
  if (!groundId) return [];
  try { const k = _obsPoolKey(groundId); const got = await chrome.storage.local.get(k); return deserializePool(got?.[k]); }
  catch { return []; }
}
const _obsPoolChains = new Map();
function _obsPoolChained(groundId, fn) {
  const tail = _obsPoolChains.get(groundId) || Promise.resolve();
  const next = tail.then(() => fn());
  const stored = next.catch(() => {});
  _obsPoolChains.set(groundId, stored);
  stored.then(() => { if (_obsPoolChains.get(groundId) === stored) _obsPoolChains.delete(groundId); });
  return next;
}
async function _mutateObsPool(groundId, fn) {
  if (!groundId || typeof fn !== 'function') return [];
  return _obsPoolChained(groundId, async () => {
    const cur = await _readObsPool(groundId);
    let next; try { next = fn(cur); } catch { next = cur; }
    if (next == null || next === cur) return cur;
    try { await chrome.storage.local.set({ [_obsPoolKey(groundId)]: serializePool(next) }); }
    catch (e) { Logger.warn('background', `observed-pool write failed: ${e.message}`); }
    return next;
  });
}
// Remove matcher-facing capabilities matching a predicate (ORCH-ADMIN bulk delete + REPLAY self-heal of an
// orphan whose underlying Strategy is gone). Returns how many were removed. The `sgCapabilities:<ground>` store
// is what the matcher reads, SEPARATE from the Tier-1 `strategies:*` records — so it must be pruned in lockstep.
// A tab open since BEFORE an extension reload keeps a stale content-script port → "Receiving end does not exist"
// on every message. PING the tab; if dead, RE-INJECT the content script (the module-load guard makes a re-inject
// of a live script a no-op) and re-PING. Returns true if reachable. Called before a REPLAY so a stale tab heals
// instead of failing the whole run.
async function _ensureContentScript(tabId) {
  if (typeof tabId !== 'number') return false;
  const ping = async () => { try { const p = await chrome.tabs.sendMessage(tabId, { type: 'PING' }); return !!(p && (p.ready || p.success)); } catch { return false; } };
  if (await ping()) return true;
  try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['ContentScripts/contentScript.js'] }); } catch { /* */ }
  for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 250)); if (await ping()) return true; }
  return false;
}

async function _removeSgCapabilities(groundId, predicate) {
  if (!groundId || typeof predicate !== 'function') return 0;
  return _sgCapChained(groundId, async () => {   // v2.74.932 (CR-ST2) — prunes serialize against alias/accept writes
    const k = _sgCapKey(groundId);
    const list = await _readSgCapabilities(groundId);
    const keep = list.filter((c) => !predicate(c));
    const removed = list.length - keep.length;
    if (removed > 0) {
      if (keep.length) await chrome.storage.local.set({ [k]: keep });
      else await chrome.storage.local.remove(k);
    }
    return removed;
  });
}
async function _writeSgTrace(trace) {
  if (!trace?.trialRef) return;
  try { await chrome.storage.local.set({ [_sgTraceKey(trace.trialRef)]: trace }); }
  catch (e) { Logger.warn('background', `SG trace write failed: ${e.message}`); }
}
async function _writeSgDraft(groundId, draft) {
  if (!groundId || !chrome.storage.session) return;
  try { await chrome.storage.session.set({ [_sgDraftKey(groundId)]: draft }); }
  catch (e) { Logger.warn('background', `SG draft write failed: ${e.message}`); }
}
async function _readSgDraft(groundId) {
  if (!groundId || !chrome.storage.session) return null;
  try { const k = _sgDraftKey(groundId); const got = await chrome.storage.session.get(k); return got?.[k] ?? null; }
  catch { return null; }
}
async function _clearSgDraft(groundId) {
  if (!groundId || !chrome.storage.session) return;
  try { await chrome.storage.session.remove(_sgDraftKey(groundId)); } catch { /* */ }
}

// SG-LM-4b — accept-time landmark enrichment. The recoverable landmark is ALREADY saved (selector + role
// + accessibleName); this DEEPENS it: INSPECT the live element to capture hierarchicalContext (the
// ancestor anchor LANDMARK_PROBE_OR_RECOVER uses to disambiguate) + capabilities, then generate the rich
// authored profile (description / aliases / pitfalls / expectedContent). Best-effort + per-landmark — a
// miss (element gone, LLM error) just leaves the already-saved recoverable record. Runs ASYNC after
// accept responds, so it never blocks the user; pays the LLM cost only for capabilities that passed.
async function _enrichSgLandmark(tabId, record) {
  if (typeof tabId !== 'number' || !record?.selector || !record?.uid) return false;
  let report = null;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'INSPECT_ELEMENT', payload: { target: record.selector, pickLast: false } }, { frameId: 0 });
    if (r?.success) report = r.report ?? null;
  } catch { /* element gone / no content script — keep the recoverable record */ }
  if (!report) return false;
  const patch = {};
  if (report.hierarchicalContext) patch.hierarchicalContext = report.hierarchicalContext;   // the recovery disambiguator
  let ops = null;
  try { const caps = deriveCapabilities(report); ops = deriveAllowedOperations(caps); patch.capabilities = caps; patch.allowedOperations = ops; } catch { /* */ }
  try {
    const res = await AnthropicService.generateLandmarkProfile({
      role: (record.alias || record.accessibleName || 'landmark').toString().trim(),
      currentSelector: record.selector,
      fingerprint: { tag: report.tag, inputType: report.inputType, ariaRole: report.ariaRole, ariaLabel: report.ariaLabel, capabilities: patch.capabilities },
      outerHTMLPreview: report.outerHTMLPreview ?? '',
      parentOuterHTMLPreview: report.parent?.outerHTMLPreview ?? '',
      frame: report.frame ?? 'top',
      matchedCount: report.matchCount ?? 1,
      screenshotDataUrl: null,
      operationsAllowed: ops,
    });
    const p = res?.profile;
    if (p) {
      if (typeof p.description === 'string' && p.description.trim()) patch.description = p.description;
      const aliases = Array.isArray(p.aliases) ? p.aliases.filter((s) => s && s.trim() && s !== record.alias) : [];
      if (aliases.length) patch.aliases = aliases;
      if (Array.isArray(p.operationsCommon) && p.operationsCommon.length) patch.operationsCommon = p.operationsCommon;
      if (Array.isArray(p.pitfalls)) patch.pitfalls = p.pitfalls;
      if (p.expectedContent !== undefined) patch.expectedContent = p.expectedContent;
      if (p.effect) patch.effect = p.effect;
      if (p.interactionPattern) patch.interactionPattern = p.interactionPattern;
      if (typeof p.confidence === 'number') patch.profileConfidence = p.confidence;
    }
  } catch (e) { Logger.warn('background', `enrich generateLandmarkProfile(${record.uid}) failed: ${e.message}`); }
  if (Object.keys(patch).length) {
    try { await StorageManager.saveLandmark({ ...record, ...patch }); return true; }
    catch (e) { Logger.warn('background', `enrich saveLandmark(${record.uid}) failed: ${e.message}`); }
  }
  return false;
}
// Enrich a promoted capability's landmarks SEQUENTIALLY (no LLM burst → avoids the 503 we saw on the
// parallel profile path). Fire-and-forget from ACCEPT_SG_TRIAL.
async function _enrichSgLandmarks(tabId, landmarks) {
  let n = 0;
  for (const lm of (Array.isArray(landmarks) ? landmarks : [])) {
    try { if (await _enrichSgLandmark(tabId, lm?.record)) n++; } catch { /* */ }
  }
  if (n) Logger.info('background', `ACCEPT_SG_TRIAL — enriched ${n} landmark profile(s) (async, post-accept)`);
}

// SG-4 / PB shared trial EXECUTOR — synth → safety class → throwaway Fragment+Strategy → execute → score.
// Used by BOTH RUN_PERSPECTIVE_TRIAL (a resolved bundle) and RUN_SG_TRIAL (Comprehend→Select→Cover→Bind).
// Returns the response object (caller sendResponse()s it). The `irreversible` safety class DEFERS the
// commit step, so a trial proves fill-ability without actually submitting. PURE side-effect surface: it
// builds throwaway artifacts (deleted in finally) and runs them — never enqueued to the cloud.
async function _runTrialBundle({ groundId, intent, roles, localeModel = null, navigateUrl = null, proposedRoleCount = 0, targetTabId = null }) {
  const draft0 = synthesizeTrialOp({ groundedIntent: intent, roles, locale: localeModel, navigateUrl });
  const safety = classifyTrialSafety(intent, draft0);
  const draft = { ...draft0, actions: safety.actions };
  try {
    await _appendOutcomes(groundId, [Outcomes.makeStageEvent('synthesize', {
      groundId, input: { roleOrIntent: String(intent).slice(0, 120) },
      detail: { shape: draft0.shape, safetyClass: safety.safetyClass, actionCount: draft.actions.length, runnable: draft0.runnable, deferred: safety.deferred.length },
    })]);
  } catch (e) { Logger.warn('background', `trial synth outcome: ${e.message}`); }

  if (!draft0.runnable) return { success: true, ran: false, reason: 'no actionable steps in the bundle', draft, safetyClass: safety.safetyClass };

  // Throwaway Fragment+Strategy — built, run once, deleted. Direct StorageManager saves bypass the sync
  // bridge, so trial artifacts are never enqueued to the cloud.
  const fragmentId = crypto.randomUUID();
  const strategyId = crypto.randomUUID();
  const recs = CapabilitySynth.buildCapabilityRecords(draft, { groundId, fragmentId, strategyId });
  if (!recs) return { success: false, error: 'failed to build trial op' };
  // v2.74.923 (CR-M2) — the trial's clicks are engine activity: mark INSIDE the shared helper so BOTH
  // entry points are covered (RUN_PERSPECTIVE_TRIAL — the un-migrated twin that silently missed the
  // .912 handler-level fix — and RUN_SG_TRIAL, whose own mark now just nests on the CR-M1 refcount).
  // When targetTabId is null the engine opens its own tab — that id isn't visible here (known gap;
  // closes when trial tab handling centralizes in the CR-X3 migration).
  if (typeof targetTabId === 'number') markEngineBusy(targetTabId, true);
  let result = null;
  try {
    await StorageManager.saveFragment(recs.fragment);
    await StorageManager.saveStrategy(recs.strategy);
    // SG/perspective trial: run on the caller's live tab (THIS Locale's page) when given,
    // instead of opening a fresh tab on ground.url (an entirely different page).
    result = await ExecutionEngine.executeStrategy({ strategyId, targetTabId });
  } finally {
    if (typeof targetTabId === 'number') markEngineBusy(targetTabId, false);   // v2.74.923 (CR-M2)
    try { await StorageManager.deleteStrategy(strategyId); } catch { /* */ }
    try { await StorageManager.deleteFragment(fragmentId); } catch { /* */ }
  }
  const scored = scoreTrial({
    shape: draft0.shape, safetyClass: safety.safetyClass,
    resolvedRoleCount: roles.length, proposedRoleCount,
    deferred: safety.deferred, result,
  });
  try {
    await _appendOutcomes(groundId, [Outcomes.makeStageEvent('trial', {
      groundId, verdict: scored.verdict, input: { roleOrIntent: String(intent).slice(0, 120) },
      detail: { ...scored.vector, score: scored.score, shape: draft0.shape, safetyClass: safety.safetyClass },
    })]);
  } catch (e) { Logger.warn('background', `trial outcome: ${e.message}`); }
  return { success: true, ran: true, safetyClass: safety.safetyClass, deferred: safety.deferred, draft, result, trial: scored };
}

async function _readOutcomes(groundId) {
  if (!groundId) return [];
  await _ensureStorageMigrated();
  try {
    const k = _outcomesKey(groundId);
    const got = await chrome.storage.local.get(k);
    return got?.[k] ?? [];
  } catch (e) {
    Logger.warn('background', `outcomes read failed: ${e.message}`);
    return [];
  }
}

// v2.74.431 — Ground siteMap (GROUND_SPEC § 7). One per ground; each captured Locale merges
// its contribution (a modeled self-node + discovered nav-destination nodes/edges) into it.
// v2.74.463 — now stored under its own key `siteMap:<groundId>` (was an entry in siteMapCache).
async function _readSiteMap(groundId) {
  return GroundAssetStore.readSiteMap(groundId);
}

async function _mergeSiteMapForGround(groundId, contribution) {
  if (!groundId || !contribution) return;
  await _ensureStorageMigrated();
  try {
    const existing = await GroundAssetStore.readSiteMap(groundId);
    const merged = SiteMap.mergeSiteMap(existing ?? null, contribution);
    await GroundAssetStore.writeSiteMap(groundId, merged);
    const s = SiteMap.siteMapStats(merged);
    Logger.info('explore', `siteMap[${groundId}]: ${s.modeled} modeled · ${s.discovered} discovered · ${s.stub} stub · ${s.edges} edge(s)`);
  } catch (e) { Logger.warn('background', `siteMap merge failed: ${e.message}`); }
}

// v2.74.481 — Ground.chrome (GROUND_SPEC § 4): the global header/nav/footer controls
// hoisted off the per-archetype Locales so they're modeled ONCE. Per-ground key, mirroring
// siteMap. DERIVED (re-derivable) from all of a Ground's Locales via Core/chromeHoist. This
// slice is ADDITIVE — Locales keep their own copies for now; the composing reads + Explore-
// skip (the actual de-duplication) land in the next slice, so nothing that reads
// `locale.features` breaks while the canonical set is being established.
const _chromeKey = (groundId) => `chrome:${groundId}`;

async function _readGroundChrome(groundId) {
  return GroundAssetStore.readChrome(groundId);
}

// All modeled Locales of a Ground as [{key, locale}] (key = localeCache cacheKey), the
// input hoistChrome tallies UIDs across.
async function _readAllLocales(groundId) {
  if (!groundId) return [];
  try {
    const got = await chrome.storage.local.get(LOCALE_CACHE_KEY);
    const byKey = got?.[LOCALE_CACHE_KEY]?.[groundId] ?? {};
    return Object.entries(byKey)
      .map(([key, entry]) => ({ key, locale: entry?.model }))
      .filter((e) => e.locale && e.locale.features);
  } catch (e) { Logger.warn('background', `localeCache list failed: ${e.message}`); return []; }
}

// Re-derive Ground.chrome from every current Locale (non-destructive). Best-effort; a UID
// must recur in ≥2 Locales to promote, so this no-ops below that. Called after each Explore.
async function _deriveGroundChrome(groundId) {
  if (!groundId) return null;
  const locales = await _readAllLocales(groundId);
  if (locales.length < 2) return null;   // need a 2nd sighting of a UID before anything promotes
  const result = ChromeHoist.hoistChrome(locales);
  const artifact = {
    schema: 1,
    chrome: result.chrome,
    overrides: result.overrides,
    chromeLayers: result.chromeLayers,   // promoted disclosures' depth (reveal Layers)
    chromeHidden: result.chromeHidden,   // those Layers' hidden child Features
    promotedIds: result.promotedIds,
    stats: result.stats,
    builtAt: Date.now(),
  };
  await GroundAssetStore.writeChrome(groundId, artifact);
  Logger.info('explore', `Ground.chrome[${groundId}]: ${result.stats.promoted} promoted across ${result.stats.locales} Locale(s) (${result.stats.candidates} recurring candidate(s))`);
  return artifact;
}

// Lazy fold-on-read (OUTCOMES_SPEC § 4): recompute the derived rollups from the
// stream on demand rather than maintaining them per-event. Returns the three
// artifact rollup bundles + the raw count, for consumers (resolve bias, studio,
// active decay) to read.
async function _outcomeRollups(groundId) {
  const stream = await _readOutcomes(groundId);
  return {
    featureHealth: Outcomes.foldFeatureHealth(stream),
    perspectiveUsage: Outcomes.foldPerspectiveUsage(stream),
    conventions: Outcomes.foldConventions(stream),
    eventCount: stream.length,
  };
}

// v2.74.385 — Flatten the cached Locale's Features into verified
// {label, role, selector} hints for resolveRoles to reuse. Each Feature's selector
// was synthesized from a real element at capture (incl. disclosure triggers + their
// revealed children, folded in from the Explore sweep) — far better than letting
// Claude guess a positional selector on a hashed-class page. (v2.74.426 #2 P3.)
async function _knownSelectorsForUrl(groundId, url) {
  if (!groundId) return null;
  const cacheKey = _normalizeUrlForPerspectiveCache(url);
  const out = [];
  const seenSel = new Set();
  const TOTAL = 140;
  const push = (item) => {
    if (!item?.selector || seenSel.has(item.selector) || out.length >= TOTAL) return;
    seenSel.add(item.selector); out.push(item);
  };

  // v2.74.426 — #2 P3: the whole-page Locale catalog is the SINGLE source of resolve
  // hints. Its L1 features already include the disclosure triggers + their revealed
  // children (folded from the poke sweep via mergeDepthFromControls), plus off-screen
  // controls + content collections the sweep never reaches. Each was synthesized from
  // a real element at capture; downstream INSPECT verifies every chosen selector, so a
  // stale hint is caught, not trusted. (Resolve = selection over the catalog.) The raw
  // pageStructure-controls pass is gone — it duplicated this with less curation.
  try {
    const pm = await _readLocaleCache(groundId, cacheKey);
    const feats = pm?.model?.features ? Object.values(pm.model.features) : [];
    const KIND_PRI = { input: 0, action: 1, collection: 2, navigation: 3, disclosure: 4 };
    feats
      .filter((f) => f?.selector && Object.prototype.hasOwnProperty.call(KIND_PRI, f.kind))
      .sort((a, b) => KIND_PRI[a.kind] - KIND_PRI[b.kind])
      .forEach((f) => push({ label: f.label || '', role: f.a11yRole || f.kind, selector: f.selector,
        // v2.74.447 — other-language labels (cross-locale harvest) so resolve matches any language.
        aliases: f.labelsByLocale ? Object.values(f.labelsByLocale).filter((l) => l && l !== f.label) : [] }));
  } catch (e) { Logger.warn('background', `_knownSelectorsForUrl (locale) failed: ${e.message}`); }

  // v2.74.487 — Augment with Ground.chrome (GROUND_SPEC § 4): the global header/nav/footer
  // controls hoisted off ALL the ground's Locales. A chrome control modeled once on another
  // archetype is a verified selector THIS page can resolve against even if its own Locale
  // missed it — "modeled once, resolves everywhere". Appended after the page's own features so
  // page-specific context wins; the push() dedup drops any the Locale already supplied. This
  // page's overrides (e.g. collapsed search) are applied via chromeFeaturesForLocale.
  try {
    const gc = await _readGroundChrome(groundId);
    if (gc && gc.chrome) {
      const CHROME_PRI = { input: 0, action: 1, collection: 2, navigation: 3, disclosure: 4 };
      ChromeHoist.chromeFeaturesForLocale(gc, cacheKey)
        .filter((f) => f?.selector && Object.prototype.hasOwnProperty.call(CHROME_PRI, f.kind))
        .sort((a, b) => CHROME_PRI[a.kind] - CHROME_PRI[b.kind])
        .forEach((f) => push({ label: f.label || '', role: f.a11yRole || f.kind, selector: f.selector,
          aliases: f.labelsByLocale ? Object.values(f.labelsByLocale).filter((l) => l && l !== f.label) : [], chrome: true }));
    }
  } catch (e) { Logger.warn('background', `_knownSelectorsForUrl (chrome) failed: ${e.message}`); }

  return out.length ? out : null;
}

// R1 seed (code_review_2.74.605 §5) — domain message-handler registry. SG handlers live in their own
// module; new domains register here instead of growing the switch below. ctx supplies the shared
// background-local helpers the SG handlers need (kept here because non-SG code uses them too).
// SG spec+selection cache (v2.74.641, audit C3) — the GROUND_INTENT propose flow computes a GOOD spec
// (matchSubGoals over the page's Locale) at the page-appropriate shape; RUN_SG_TRIAL was re-comprehending
// from scratch, RE-ROLLING the shape (act→read) and re-matching, which on a multi-filter intent matched
// the filters to INPUTS (distance→location box, pay→a job-card input) and broke the run. Cache the
// propose-time { spec, selection } keyed by ground + normalized page URL + normalized intent (short TTL,
// since the selection is page-state-specific); RUN_SG_TRIAL reuses it — deterministic, the GOOD matches,
// and 2 fewer LLM calls per run. A miss (page navigated / TTL lapsed / never proposed) re-comprehends.
const _sgSpecCache = new Map();
const SG_SPEC_TTL_MS = 5 * 60 * 1000;
const _sgSpecKey = (groundId, url, intent) => `${groundId || ''}::${_normalizeUrlForPerspectiveCache(url || '')}::${String(intent || '').trim().toLowerCase().slice(0, 300)}`;
function _cacheSgSpec(groundId, url, intent, spec, selection) {
  if (!groundId || !spec) return;
  try { _sgSpecCache.set(_sgSpecKey(groundId, url, intent), { spec, selection: selection || null, at: Date.now() }); } catch { /* */ }
}
function _readSgSpec(groundId, url, intent) {
  try { const e = _sgSpecCache.get(_sgSpecKey(groundId, url, intent)); if (e && (Date.now() - e.at) < SG_SPEC_TTL_MS) return { spec: e.spec, selection: e.selection }; } catch { /* */ }
  return null;
}

// v2.74.951 (CR-X3a) — domain handler maps merge here; the dispatch + _invokeSgHandler serve them all.
const _sgMessageHandlers = {
  ...createConnectorHandlers({ ensureContentScript: _ensureContentScript, readRideRecipes: _readRideRecipes, writeRideRecipes: _writeRideRecipes, cloudInvokeConnector: invokeConnector, cloudLinkConnector: linkConnector, cloudUnlinkConnector: unlinkConnector, cloudListConnectorTools: listConnectorTools,   // RH-1a (v2.74.1566) — writeRideRecipes: the heal tick stamps lastOkAt/driftSuspect on per-Ground records
    cloudHasSession: async () => { try { const s = await ensureFreshSession(); return !!(s && s.idToken); } catch { return false; } } }),   // CX-3 — connector domain (INVOKE_SESSION session-ride); §18 — readRideRecipes feeds the arm guard; CX-5b — cloudInvokeConnector → INVOKE_CONNECTOR broker; MP-3 — cloudLinkConnector → LINK_CONNECTOR; CX-5c — unlink + status; v1312 — link preflight
  ...createCanvasHandlers({   // CA-4 RENDER_CANVAS + CA-9 COMPOSE_CANVAS (the app authors a spec → render)
    log: (line) => { try { Logger.info('background', line); } catch { /* */ } },
    composeCanvas: (args) => AnthropicService.composeCanvas(args),
    cloudInvokeConnector: invokeConnector,   // GD-3 (§8) — the gdoc backend paints via the broker's REST channel
  }),
  ...createWorkflowDebugHandlers({
    invokeSgHandler        : _invokeSgHandler,
    ensureContentScript    : _ensureContentScript,
    broadcastStorageChanged,   // v2.74.1763 — both were CALLED but never passed: a ReferenceError waiting on
    deleteRecordWithSync,      // SAVE_WORKFLOW / DELETE_WORKFLOW (the legacy Studio authoring path)
  }),
  ...createFleetHandlers({ invokeSgHandler: _invokeSgHandler }),   // FL-6 (v1355) — FLEET_SCHEDULE (set/off/status); the alarm listener registers below
  ...createConnectionsHandlers({ invokeSgHandler: _invokeSgHandler }),   // CP-1/2 (v1506) — CONN_LIST / CONN_CHECK / CONN_FOCUS (the auth-presence registry)
  ...createPipelineHandlers(),   // PP (v2.74.1665) — PIPELINE_OPEN_ITEMS / PIPELINE_RECORD_ITEM / PIPELINE_CASES / PIPELINE_CLOSE_CASE
  ...createExerciserHandlers(),   // EX-1 (v2.74.1946) — DEV_RELOAD_EXTENSION / DEV_RUN_ASK: the loop can restart the build it just made and put an ask through the front door
  ...createVitalsHandlers(),   // VT-2 (v2.74.1571) — VITALS_STATUS / VITALS_BADGE / VITALS_CHECK_NOW (the Admin desk's read surface)
  ...createCadenceHandlers(),   // CD-1 (v2.74.1692) — WORKFLOW_TRIGGER_SET / WORKFLOW_RUNS / WORKFLOW_RUN_FIRE (arm a cadence · read run history · manual headless fire)

  ...createDiscoveryHandlers({
    readSiteMap          : _readSiteMap,
    mergeSiteMapForGround: _mergeSiteMapForGround,
    readRideRecipes      : _readRideRecipes,        // §17 (1b) — auto-harvest ride-recipes during the crawl (bank target)
    writeRideRecipes     : _writeRideRecipes,
    syncGroundAssetsAfterSave,   // v2.74.1763 — called on the sitemap-seed path; was never seamed
  }),
  ...createForageHandlers({                          // §19 — Forage (recipe-capture nav crawl); banks into the ride store
    readRideRecipes      : _readRideRecipes,
    writeRideRecipes     : _writeRideRecipes,
  }),
  ...createExploreHandlers({
    readLocaleCache      : _readLocaleCache,
    writeLocaleCache     : _writeLocaleCache,
    normalizeUrl         : _normalizeUrlForPerspectiveCache,
    readSiteMap          : _readSiteMap,
    mergeSiteMapForGround: _mergeSiteMapForGround,
    readGroundChrome     : _readGroundChrome,
    deriveGroundChrome   : _deriveGroundChrome,
    appendOutcomes       : _appendOutcomes,
    readRideRecipes      : _readRideRecipes,        // §17 — Explore-depth ride-recipe harvest (poke-triggered reads); bank target
    writeRideRecipes     : _writeRideRecipes,
    syncGroundAssetsAfterSave,   // v2.74.1763 — called on the locale-modeled path; was never seamed
  }),
  ...createSgMessageHandlers({
  runTrialBundle       : _runTrialBundle,
  readLocaleCache      : _readLocaleCache,
  readSgSpec           : _readSgSpec,
  normalizeUrl         : _normalizeUrlForPerspectiveCache,
  appendOutcomes       : _appendOutcomes,
  readOutcomes         : _readOutcomes,                 // ORCH-G — gate promotion reads confirmation health
  outcomeRollups       : _outcomeRollups,               // GA-5 — per-Ground conventions histogram for the Select tie-break
  broadcastStorageChanged,
  readSgCapabilities   : _readSgCapabilities,
  readSiteMap          : _readSiteMap,              // G1-3 — siteMap node count for Ground readiness
  readSgDraft          : _readSgDraft,
  writeSgDraft         : _writeSgDraft,
  clearSgDraft         : _clearSgDraft,
  writeSgCapability    : _writeSgCapability,
  removeSgCapabilities : _removeSgCapabilities,   // ORCH-ADMIN / self-heal — prune matcher-facing capabilities
  ensureContentScript  : _ensureContentScript,    // heal a stale-tab content-script port before REPLAY
  writeSgTrace         : _writeSgTrace,
  enrichSgLandmarks    : _enrichSgLandmarks,
  readGaps             : _readGaps,                // PS-0 — Orchard's per-Ground capability-gap registry (read)
  mutateGaps           : _mutateGaps,              // PS-0/1 — atomic per-Ground read-modify-write of the gaps registry (serialized)
  mutateObsPool        : _mutateObsPool,           // PS-2 — atomic per-Ground RMW of the long-tail observed pool
  readRideRecipes      : _readRideRecipes,         // §18 — the per-Ground ride-recipe collection (read)
  writeRideRecipes     : _writeRideRecipes,        // §18 — replace the per-Ground ride-recipe list (chained RMW)
  readDriveArtifacts   : _readDriveArtifacts,      // HL-1 (v2.74.1454) — the per-Ground drive-artifact collection (read)
  writeDriveArtifacts  : _writeDriveArtifacts,     // HL-1 — replace the per-Ground drive-artifact list (chained RMW)
  getDemoWriteCaptures : () => _obsLastWriteCaptures,   // CX-8c — DERIVE reads the demo's captured writes to bank pending ride write-recipes
  }),
};

// v2.74.950 (CR-X3b) — THE sendResponse->Promise bridge. Registry handlers reply via sendResponse;
// every in-SW caller that needs the result AS A VALUE used to hand-roll this wrap (auto-monitor x2,
// the workflow executor's runObservation/runCapability handoffs) — with drifting safety nets (one
// HUNG forever if the handler rejected before responding). One implementation, never rejects.
function _invokeSgHandler(type, payload) {
  return new Promise((resolve) => {
    const h = _sgMessageHandlers[type];
    if (typeof h !== 'function') { resolve({ success: false, error: `no SG handler: ${type}` }); return; }
    try {
      Promise.resolve(h(payload, null, (r) => resolve(r ?? null)))
        .catch((e) => resolve({ success: false, error: e?.message || String(e) }));
    } catch (e) { resolve({ success: false, error: e.message }); }
  });
}

// ── C2b auto-monitor orchestration ───────────────────────────────────────────
// With GLOBAL live-monitoring on, capture FOLLOWS the user: every eligible tab (canTrack: enabled ∧
// host not excluded) auto-starts a capture session; toggling off / excluding a host stops the affected
// tabs. No per-page opt-in. onUpdated/onActivated are START-only (a fresh page's content script defaults
// to off); a consent change re-evaluates every open tab (START eligible, STOP ineligible).
const _autoMonitorBusy = new Set();
async function _autoMonitorTab(tabId, { stopIfIneligible = false } = {}) {
  if (typeof tabId !== 'number' || _autoMonitorBusy.has(tabId)) return;
  _autoMonitorBusy.add(tabId);
  try {
    let url = ''; try { url = (await chrome.tabs.get(tabId))?.url || ''; } catch { return; }
    if (!/^https?:/i.test(url)) return;
    let host = ''; try { host = new URL(url).host; } catch { /* */ }
    let consent = null; try { consent = (await chrome.storage.local.get('monitor:consent'))?.['monitor:consent'] || null; } catch { /* */ }
    if (canTrack(consent, { host })) {
      await _invokeSgHandler('INTERACTION_MONITOR_START', { tabId });   // v2.74.950 (CR-X3b) — the one bridge
    } else if (stopIfIneligible) {
      await _invokeSgHandler('INTERACTION_MONITOR_STOP', { tabId });   // v2.74.950 (CR-X3b) — the one bridge
    }
  } catch { /* */ } finally { _autoMonitorBusy.delete(tabId); }
}
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info && info.status === 'complete') _autoMonitorTab(tabId); });
chrome.tabs.onActivated.addListener((a) => { if (a && typeof a.tabId === 'number') _autoMonitorTab(a.tabId); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes || !changes['monitor:consent']) return;
  try { chrome.tabs.query({}, (tabs) => { for (const t of (tabs || [])) if (typeof t.id === 'number') _autoMonitorTab(t.id, { stopIfIneligible: true }); }); } catch { /* */ }
});

// ── OBS-1: demonstration recording session ───────────────────────────────────
// One active session at a time. The content script captures user interactions (INTERACTION_RECORD); we
// buffer them into a raw trace, assigning seq + frameId. Navigations are captured here (the content script
// is replaced on each page) and we RE-ARM the content-script listeners on the freshly-loaded page so a
// multi-page demonstration (search → job → apply) records as ONE trace. coalesce() runs on read.
let _obsSession = null;   // { tabId, startedAt, seq, trace: RawAction[], lastUrl }
let _obsLastWriteCaptures = [];   // CX-8c — the app's OWN write request(s) captured during the last demonstration (page-local bodies, drained at STOP); DERIVE templates them into pending ride write-recipes, then they're consumed.
function _obsArm(tabId) { try { chrome.tabs.sendMessage(tabId, { type: 'RECORD_START' }, () => void chrome.runtime.lastError); } catch { /* */ } }
function _obsDisarm(tabId) { try { chrome.tabs.sendMessage(tabId, { type: 'RECORD_STOP' }, () => void chrome.runtime.lastError); } catch { /* */ } }
// CX-8c (v2.74.1299) — DEMONSTRATE-ONCE write capture. Arm the page's body-capturing tee for the demo window
// (opt-in flag + inject the tee MAIN-world), then drain window.__ahub_write_buf at stop. PAGE-LOCAL: the raw
// bodies are templated by recipeFromObservedWrite (typed values → params) before anything banks; the flag is
// cleared at stop so capture is strictly demo-scoped. Best-effort — never blocks the recorder.
async function _obsArmBodyCapture(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => { try { sessionStorage.setItem('__ahub_cap_body', '1'); window.__ahub_write_buf = []; } catch (e) {} } });
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['ContentScripts/harvestTee.js'] });   // idempotent — wraps fetch/XHR if not already on this page
  } catch (e) { Logger.warn('background', `OBS body-capture arm failed: ${e.message}`); }
}
async function _obsDrainBodyCapture(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => { try { var b = Array.isArray(window.__ahub_write_buf) ? window.__ahub_write_buf.slice() : []; sessionStorage.removeItem('__ahub_cap_body'); window.__ahub_write_buf = []; return b; } catch (e) { return []; } } });
    return (r && Array.isArray(r.result)) ? r.result : [];
  } catch (e) { Logger.warn('background', `OBS body-capture drain failed: ${e.message}`); return []; }
}
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!_obsSession || tabId !== _obsSession.tabId) return;
  if (info.status === 'complete') {
    const url = (tab && tab.url) || info.url || '';
    if (url && url !== _obsSession.lastUrl) {
      _obsSession.trace.push(buildRawAction({ seq: _obsSession.seq++, ts: Date.now(), url, from: _obsSession.lastUrl, frameId: 0, domKind: 'navigate' }));
      _obsSession.lastUrl = url;
    }
    _obsArm(tabId);   // the page reloaded → re-install the capture listeners on the new content script
  } else if (info.url && info.url !== _obsSession.lastUrl) {
    // SOFT navigation (SPA pushState/replaceState): the URL changed with NO reload — a LOGICAL page-state change
    // (search → results, then filter → re-filtered results), the SPA half of the fragment-boundary rule. Chrome
    // fires onUpdated with changeInfo.url but no status cycle for History API changes, so the `complete` branch
    // never sees it. Record it as a `navigate` boundary so the segmenter splits the fragment here exactly as a
    // hard reload would. The content script is still alive (no reload) → no re-arm. (A URL-less client-side filter
    // emits no onUpdated and still needs the content-script content-diff `state_change` marker — separate slice.)
    _obsSession.trace.push(buildRawAction({ seq: _obsSession.seq++, ts: Date.now(), url: info.url, from: _obsSession.lastUrl, frameId: 0, domKind: 'navigate' }));
    _obsSession.lastUrl = info.url;
  }
});

// v1467 (obs #7) — the read-only VIEWER pump (Studio/panel poll getters) drowned the trace: one Studio open emitted
// ~60 `Message:` DEBUG lines (~40% of a day's exported log), burying the decision signal. These carry zero decision
// content — drop them from the log entirely (the handlers still run; a FAILING getter logs from its own handler).
// v2.74.1858 — PANEL_PING joins them (gl 121742: 444 of 508 lines — 87% of a 74-minute trace — were the
// 10-second panel heartbeat, and the ring is FINITE: at 6 lines/min an idle panel evicts the very decisions a
// later grab needs. Zero decision content by construction; the panel's liveness is already legible from the
// work it does. Same rule as the v1674 per-item INVOKE drop, one level down: a marker that fires on a CLOCK
// must never occupy the ring.)
const _QUIET_MSG = new Set(['GET_SITEMAP', 'GET_GROUND_CHROME', 'GET_OUTCOMES', 'GET_RIDE_RECIPES', 'GET_LOGS', 'LOG_ENTRY', 'GET_MONITOR_CONSENT', 'CAPABILITY_LIST_INVOCATIONS', 'GET_LEG_OVERVIEW', 'GET_RIDE_ARMED_GROUNDS', 'PANEL_PING']);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;
  // v2.74.1861 — a QUIETED per-item call skips its dispatch line too. v1860 suppressed the fan-out's `INVOKE ▸`
  // INFO lines but left this DEBUG line firing 1:1 — so a 121-way fan-out still wrote 121 ring entries and still
  // evicted the window's earlier asks (gl 162926: the trace opens on 20 orphan `Message: INVOKE_SESSION` lines,
  // the tail of a fan-out whose boot line and first asks were already gone). Half a fix is a fix that measures
  // as done. Only the per-item flag is honored, so every ordinary dispatch still logs exactly as before.
  // PERF ▸ v2.74.1981 — TEMPORARY: the FIRST message handled after a cold start, measured from SW wake
  // (performance.now() ≈ ms since the SW's timeOrigin). Fires once per SW lifetime. Remove with the PERF block.
  try { if (!self.__perfFirstDispatch) { self.__perfFirstDispatch = 1; Logger.info('background', `PERF ▸ sw:first-dispatch type=${type} since-wake=${Math.round(performance.now())}ms`); } } catch { /* */ }
  if (!_QUIET_MSG.has(type) && !(payload && payload.quiet === true)) Logger.debug('background', `Message: ${type}`);

  // Registry dispatch (R1): SG handlers call sendResponse themselves (verbatim with the old switch); the
  // `.catch` is a safety net if a handler rejects before responding. Checked before the legacy switch;
  // both keep the async `return true`. Own-property guard so an odd `type` ('toString', 'constructor', …)
  // can't match an inherited Object.prototype member.
  if (typeof type === 'string' && Object.prototype.hasOwnProperty.call(_sgMessageHandlers, type)) {
    Promise.resolve(_sgMessageHandlers[type](payload, sender, sendResponse))
      .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
    return true;
  }

  switch (type) {

    // ── DBR-P3-7 (v2.74.1060) — the dev-bridge `scope?` semantic check: a single metered structured LLM call over
    // a {system, user} prompt the panel built from the branch's diff + concern. Read-only; returns {success, text}.
    case 'DEV_SCOPE_CHECK': {
      (async () => {
        try {
          const r = await AnthropicService.devScopeCheck({ system: payload && payload.system, user: payload && payload.user });
          sendResponse(r || { success: false, error: 'no result' });
        } catch (e) { sendResponse({ success: false, error: e?.message || String(e) }); }
      })();
      return true;
    }

    case 'DEV_CATEGORIZE_SCOPE': {   // v2.74.1102 — dev-conversation drawer label: Claude categorizes the scope into a short role
      (async () => {
        try {
          const r = await AnthropicService.categorizeDevScope({ scope: payload && payload.scope });
          sendResponse(r || { success: false, error: 'no result' });
        } catch (e) { sendResponse({ success: false, error: e?.message || String(e) }); }
      })();
      return true;
    }

    // ── OBS-1: demonstration recorder ────────────────────────────────────────
    case 'RECORD_START_SESSION': {
      (async () => {
        try {
          let tabId = payload && typeof payload.tabId === 'number' ? payload.tabId : null;
          if (tabId == null) { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = t?.id ?? null; }
          if (tabId == null) { sendResponse({ success: false, error: 'no active tab' }); return; }
          let url = ''; try { const t = await chrome.tabs.get(tabId); url = t?.url || ''; } catch { /* */ }
          _obsSession = { tabId, startedAt: Date.now(), seq: 0, trace: [], lastUrl: url, seenUids: new Set() };
          _obsArm(tabId);
          _obsLastWriteCaptures = []; _obsArmBodyCapture(tabId);   // CX-8c — arm demo-scoped, opt-in write-body capture (fire-and-forget)
          Logger.info('background', `RECORD_START_SESSION — recording tab ${tabId} @ ${String(url).slice(0, 80)}`);
          sendResponse({ success: true, recording: true, tabId, url });
        } catch (e) { sendResponse({ success: false, error: e.message }); }
      })();
      return true;
    }
    case 'INTERACTION_RECORD': {
      try {
        if (_obsSession && sender?.tab?.id === _obsSession.tabId) {
          const p = payload || {};
          // Dedup: an action delivered LIVE and again via the pre-nav sessionStorage flush shares a `uid` — count once.
          if (p.uid) { if (_obsSession.seenUids.has(p.uid)) { sendResponse({ success: true, dup: true }); return false; } _obsSession.seenUids.add(p.uid); }
          // B-DIAG — surface why a category click did/didn't become a re-bindable CATEGORY group (see contentScript).
          if (p.domKind === 'click' && p.target && p.target.navDiag) Logger.info('background', `OBS click "${String(p.target.accessibleName || p.target.selector || '').slice(0, 40)}" navDiag: ${JSON.stringify(p.target.navDiag)} ${p.uid ? '(flushed)' : ''}`);
          _obsSession.trace.push(buildRawAction({ seq: _obsSession.seq++, ts: p.ts || Date.now(), url: p.url || _obsSession.lastUrl, frameId: sender.frameId | 0, domKind: p.domKind, target: p.target, value: p.sensitive ? null : p.value }));
        }
      } catch (e) { Logger.warn('background', `INTERACTION_RECORD drop: ${e.message}`); }
      sendResponse({ success: true });
      return false;
    }
    case 'GET_RECORDING': {
      const t = _obsSession ? coalesce(_obsSession.trace) : [];
      sendResponse({ success: true, recording: !!_obsSession, count: t.length, trace: t, tabId: _obsSession?.tabId ?? null });
      return false;
    }
    case 'RECORD_STOP_SESSION': {
      (async () => {
        const sess = _obsSession;
        if (sess) { _obsDisarm(sess.tabId); }
        const trace = sess ? coalesce(sess.trace) : [];
        _obsSession = null;
        // CX-8c — drain the demo's PAGE-LOCAL write-body captures so DERIVE can template + bank them (pending).
        try { _obsLastWriteCaptures = sess ? await _obsDrainBodyCapture(sess.tabId) : []; } catch { _obsLastWriteCaptures = []; }
        if (_obsLastWriteCaptures.length) Logger.info('background', `RECORD_STOP_SESSION — ${_obsLastWriteCaptures.length} write capture(s) held for CX-8c banking`);
        Logger.info('background', `RECORD_STOP_SESSION — ${trace.length} action(s) captured`);
        sendResponse({ success: true, recording: false, count: trace.length, trace, writeCaptures: _obsLastWriteCaptures.length });   // CX-8c decouple — the client banks writes even at 0 DOM actions
      })();
      return true;
    }

    // ── CapabilityAPI surface ────────────────────────────────────────────────
    case 'CAPABILITY_LIST': {
      (async () => {
        try {
          const list = await CapabilityAPI.listCapabilities(payload ?? {});
          sendResponse({ success: true, capabilities: list });
        } catch (err) {
          Logger.error('background', `CAPABILITY_LIST failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'CAPABILITY_GET': {
      (async () => {
        try {
          // v2.74.114 — Validate up front so a missing payload yields an
          // actionable error message rather than the opaque "Cannot read
          // properties of null (reading 'capabilityId')" that the bare
          // `payload.capabilityId` access used to produce.
          const { capabilityId } = payload ?? {};
          if (!capabilityId) {
            sendResponse({ success: false, error: 'capabilityId required' });
            return;
          }
          const cap = await CapabilityAPI.getCapability(capabilityId);
          sendResponse({ success: true, capability: cap });
        } catch (err) {
          Logger.error('background', `CAPABILITY_GET failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'CAPABILITY_MATCH': {
      (async () => {
        try {
          // v2.74.114 — Validate query up front.
          const { query, options } = payload ?? {};
          if (typeof query !== 'string' || !query.trim()) {
            sendResponse({ success: false, error: 'query required' });
            return;
          }
          const matches = await CapabilityAPI.match(query, options ?? {});
          sendResponse({ success: true, matches });
        } catch (err) {
          Logger.error('background', `CAPABILITY_MATCH failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ── Generate a short conversation title from the first user message.
    // Thin wrapper around AnthropicService kept behind the ChatAPI contract
    // so the chat UI never reaches into Lab internals directly.
    case 'CHAT_GENERATE_TITLE': {
      (async () => {
        try {
          const { firstMessage } = payload ?? {};
          if (!firstMessage) {
            sendResponse({ success: false, error: 'firstMessage required' });
            return;
          }
          const title = await AnthropicService.generateConversationTitle(firstMessage);
          // Fall back to a truncated version of the message if title gen failed
          const finalTitle = title
            ?? firstMessage.slice(0, 40).replace(/\s+/g, ' ').trim();
          sendResponse({ success: true, title: finalTitle });
        } catch (err) {
          Logger.error('background', `CHAT_GENERATE_TITLE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ╔══════════════════════════════════════════════════════════════════════╗
    // ║ Pass B — FRAGMENT AUTHORING                                          ║
    // ╚══════════════════════════════════════════════════════════════════════╝

    // v2.74.22 — START_FRAGMENT_WALK handler removed. AI-walked path is gone.

    // v2.72.60 — T1 (cache) Fragment authoring.
    //
    // Mirror of START_FRAGMENT_WALK for the manual-authoring path. No
    // LLM, no turn-by-turn approval. Background opens the walk tab,
    // re-injects the content script, and sets the sidepanel mode to
    // 'fragment-author' with the metadata. The user authors actions
    // directly in the sidepanel and clicks Verify per row to execute
    // each step on the live page (via EXECUTE_AUTHORING_STEP).
    case 'BEGIN_FRAGMENT_AUTHOR': {
      (async () => {
        try {
          const {
            fragmentId, groundId, groundUrl, name, description,
            pageClass = null, isRewalk = false,
            antecedentFragmentId = null, antecedentParamBindings = null,
            // v2.72.82 — Re-walk pre-fill: parsed rawJson + saved metadata.
            prefilledActions = null,
            rewalkName = null, rewalkDescription = null,
            // v2.74.31 — Reuse the user's current tab when launched from
            // the Ground sidepanel (instead of opening a fresh tab).
            existingTabId = null,
            // v2.74.33 — Where Cancel / Save should return the user.
            // 'ground-view' = back to the Ground sidepanel; otherwise
            // exitToStudio is used (the original behavior).
            returnTo = null,
            // v2.74.774 — Carry the saved pre/post conditions into the editor on a re-walk / pencil-edit. The SEND
            // side was fixed in v2.74.185 (ground-view.js) but THIS relay never destructured or forwarded the
            // fields, so they were silently dropped before the fragment-author mode ever saw them — the editor
            // opened with an empty condition list (and pre-771 auto-captured phantoms over the saved record). The
            // 769/771 hydration locks were written to CONSUME exactly these. Mirrors BEGIN_OBSERVATION_AUTHOR
            // (v2.74.149), which already forwards them.
            prefilledPreconditions  = null,
            prefilledPostconditions = null,
          } = payload ?? {};
          // v2.72.62 — T1 authors name+description IN the sidepanel mode,
          // so the form sends empty strings. Don't validate them here.
          if (!fragmentId || !groundId || !groundUrl) {
            sendResponse({ success: false, error: 'Missing required fields (fragmentId, groundId, groundUrl)' });
            return;
          }
          Logger.info('background', `BEGIN_FRAGMENT_AUTHOR — fragmentId=${fragmentId}${antecedentFragmentId ? ` antecedent=${antecedentFragmentId}` : ''}${prefilledActions ? ` prefill=${prefilledActions.length}` : ''}`);

          // v2.72.62 — Set the sidepanel mode FIRST with a "preparing"
          // status, so the mode mounts and shows progress while the tab
          // setup runs. The mode displays "Setting up: replaying
          // antecedent…" if antecedent is set; otherwise mounts straight
          // into authoring. The actual tab open + antecedent replay
          // happens via TemplateWalker.prepareTabForAuthoring below.
          __setSidepanelMode('fragment-author', {
            fragmentId, groundId, groundUrl,
            // v2.72.82 — On re-walk, prefer the saved name/description
            // from the existing fragment record.
            name: rewalkName ?? name,
            description: rewalkDescription ?? description,
            pageClass, isRewalk,
            antecedentFragmentId, antecedentParamBindings,
            prefilledActions,
            tabId: null,            // not yet opened
            // v2.74.56 — Forward existingTabId so the shell's
            // _rememberTabMode / _snapshotKey logic can key by the
            // authoring tab. Previously this field was destructured
            // from the incoming payload but never passed through, so
            // shell saw no tabId and the per-tab record was never
            // created — resume-on-return-to-tab was a no-op.
            existingTabId,
            setupPhase: antecedentFragmentId ? 'antecedent' : 'opening',
            returnTo,
            // v2.74.774 — Forward the saved conditions so the 769/771 hydration locks load them (see destructure).
            prefilledPreconditions,
            prefilledPostconditions,
          });

          // v2.72.62 — Use TemplateWalker.prepareTabForAuthoring. This
          // opens the tab, waits for the content script + page idle,
          // and replays the antecedent chain (if any) before returning.
          // Antecedent progress broadcasts via WALK_PROGRESS keyed by
          // fragmentId (the mode listens for this and updates its banner).
          let setup;
          try {
            setup = await TemplateWalker.prepareTabForAuthoring({
              groundUrl, fragmentId,
              antecedentFragmentId, antecedentParamBindings,
              isAborted: () => false,
              existingTabId,
            });
          } catch (e) {
            Logger.error('background', `BEGIN_FRAGMENT_AUTHOR setup threw: ${e.message}`);
            // Tell the mode setup failed so it can show an error.
            chrome.runtime.sendMessage({
              type: 'FRAGMENT_AUTHOR_SETUP_RESULT',
              payload: { fragmentId, success: false, error: e.message, tabId: null },
            }).catch(() => {});
            sendResponse({ success: false, error: e.message });
            return;
          }
          if (!setup.success) {
            chrome.runtime.sendMessage({
              type: 'FRAGMENT_AUTHOR_SETUP_RESULT',
              payload: { fragmentId, success: false, error: setup.error, tabId: setup.tabId },
            }).catch(() => {});
            sendResponse({ success: false, error: setup.error });
            return;
          }

          // Setup complete — broadcast the resolved tabId so the mode
          // can use it for Pick / Verify dispatches.
          chrome.runtime.sendMessage({
            type: 'FRAGMENT_AUTHOR_SETUP_RESULT',
            payload: { fragmentId, success: true, tabId: setup.tabId, error: null },
          }).catch(() => {});

          // v2.74.128 — The v2.74.40 post-resolution write to the
          // background-side __tabSidepanelModes map was removed
          // alongside the map itself. The shell maintains its own
          // _tabModes record; the FRAGMENT_AUTHOR_SETUP_RESULT broadcast
          // (above) is the channel the live fragment-author mode reads
          // for the resolved tabId.

          sendResponse({ success: true, tabId: setup.tabId });
        } catch (err) {
          Logger.error('background', `BEGIN_FRAGMENT_AUTHOR failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.22 — List fragments on a Ground. Used by the fragment-author
    // sidepanel mode's antecedent dropdown (and potentially other future
    // surfaces that need a per-ground fragment listing without going
    // through StorageManager directly). Optional excludeId filters out
    // the fragment currently being authored to prevent self-references.
    case 'LIST_FRAGMENTS_FOR_GROUND': {
      (async () => {
        try {
          const { groundId, excludeId } = payload ?? {};
          if (!groundId) {
            sendResponse({ success: false, error: 'groundId required' });
            return;
          }
          const all = await StorageManager.listFragments(groundId);
          const fragments = excludeId
            ? all.filter(f => f.id !== excludeId)
            : all;
          // Project to a compact shape. v2.74.23 — params is included so
          // the antecedent card can render its param-input row + label
          // line without a follow-up GET_FRAGMENT round-trip.
          sendResponse({
            success: true,
            fragments: fragments.map(f => ({
              id    : f.id,
              name  : f.name ?? 'Unnamed',
              params: Array.isArray(f.params) ? [...f.params] : [],
            })),
          });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.23 — Navigate a tab to a URL and wait for it to load.
    // Used by the antecedent card's "undo" path: after a successful Run,
    // the button flips to a refresh icon; clicking it sends NAVIGATE_TAB
    // with the ground's default URL to reset the page state.
    case 'NAVIGATE_TAB': {
      (async () => {
        try {
          const { tabId, url } = payload ?? {};
          if (!tabId || !url) {
            sendResponse({ success: false, error: 'tabId and url required' });
            return;
          }
          await chrome.tabs.update(tabId, { url });
          await _waitForTabLoad(tabId);
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.22 — Run an antecedent fragment on the active authoring tab,
    // driving the page into the post-state of that fragment so the user
    // can begin authoring against the right page. Triggered by the
    // fragment-author mode's antecedent + Run card.
    //
    // v2.74.23 — Always navigates the tab to the antecedent's URL
    // precondition (or its startUrl as fallback) before running, then
    // waits for the page to load. Re-clicking Run on the same antecedent
    // resets the tab to a known-good starting state so the run is
    // deterministic regardless of where the page ended up after the
    // previous run. Param bindings come from the card's input row and
    // are forwarded to executeFragment for {{NAME}} substitution.
    case 'RUN_ANTECEDENT_FOR_AUTHORING': {
      (async () => {
        try {
          const { tabId, antecedentFragmentId, paramBindings } = payload ?? {};
          if (!tabId || !antecedentFragmentId) {
            sendResponse({ success: false, error: 'tabId and antecedentFragmentId required' });
            return;
          }

          // Look up the antecedent record so we know where to navigate.
          // The url_matches precondition is preferred — it's the captured
          // page state. Fall back to startUrl, then to ground.url, then
          // give up (executeFragment will fail loudly if the page state
          // is wrong).
          const ante = await StorageManager.getFragment(antecedentFragmentId);
          if (!ante) {
            sendResponse({ success: false, error: `Antecedent fragment ${antecedentFragmentId} not found` });
            return;
          }
          const navigateUrl = _resolveAntecedentStartUrl(ante);
          if (navigateUrl) {
            try {
              await chrome.tabs.update(tabId, { url: navigateUrl });
              await _waitForTabLoad(tabId);
            } catch (e) {
              sendResponse({ success: false, error: `Navigation to "${navigateUrl}" failed: ${e.message}` });
              return;
            }
          }

          const result = await TemplateWalker.executeFragment({
            tabId,
            fragmentId   : antecedentFragmentId,
            paramBindings: (paramBindings && typeof paramBindings === 'object') ? paramBindings : {},
            broadcastKey : `antecedent-run-${antecedentFragmentId}`,
            isAborted    : () => false,
          });
          if (!result.success) {
            sendResponse({
              success: false,
              error  : result.error ?? 'antecedent run failed',
              actionsRun           : result.actionsRun ?? 0,
              antecedentActionsRun : result.antecedentActionsRun ?? 0,
            });
            return;
          }
          sendResponse({
            success              : true,
            actionsRun           : result.actionsRun,
            antecedentActionsRun : result.antecedentActionsRun ?? 0,
          });
        } catch (err) {
          Logger.error('background', `RUN_ANTECEDENT_FOR_AUTHORING failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.72.95 (Phase 1) — Begin authoring an Observation in T1 (cache)
    // mode. Mirrors BEGIN_FRAGMENT_AUTHOR: opens the target tab, mounts
    // the observation-author sidepanel mode, broadcasts the resolved
    // tabId. Observations don't have antecedent chains so we skip
    // antecedent replay entirely — the tab opens at groundUrl as-is.
    case 'BEGIN_OBSERVATION_AUTHOR': {
      (async () => {
        try {
          const {
            observationId, groundId, groundUrl, name, description, shape, output, target, extract,
            // v2.74.31 — Reuse the user's current tab when launched from
            // the Ground sidepanel (instead of opening a fresh tab).
            existingTabId = null,
            // v2.74.33 — Where Cancel / Save should return the user.
            returnTo = null,
            // v2.74.149 — Full-record seed for the Edit (✎) flow on the
            // Ground sidepanel. New-Observation and Walk-Observation
            // callers omit these; observation-author treats them as
            // optional and falls back to the legacy single-extract seed
            // when absent.
            prefilledExtracts       = null,
            prefilledPreconditions  = null,
            prefilledPostconditions = null,
            tier                    = null,
          } = payload ?? {};
          if (!observationId || !groundId || !groundUrl) {
            sendResponse({ success: false, error: 'Missing required fields (observationId, groundId, groundUrl)' });
            return;
          }
          Logger.info('background', `BEGIN_OBSERVATION_AUTHOR — observationId=${observationId} ground=${groundId}`);

          // Mount the sidepanel mode FIRST with a placeholder tabId so
          // the user sees the form immediately while the tab opens. The
          // mode will receive OBSERVATION_AUTHOR_SETUP_RESULT once the
          // tab is ready and use it for Pick/Verify dispatches.
          __setSidepanelMode('observation-author', {
            observationId, groundId, groundUrl,
            name: name ?? '',
            description: description ?? '',
            shape: shape ?? 'scalar',
            output: output ?? '',
            target: target ?? '',
            extract: extract ?? { kind: 'text' },
            tabId: null,
            // v2.74.56 — Forward existingTabId (same fix as
            // BEGIN_FRAGMENT_AUTHOR — shell needs this for per-tab
            // mode tracking).
            existingTabId,
            setupPhase: 'opening',
            returnTo,
            // v2.74.149 — Forward full-record seed for in-place edit.
            prefilledExtracts,
            prefilledPreconditions,
            prefilledPostconditions,
            tier,
          });

          // Reuse prepareTabForAuthoring (no antecedent for Observations).
          let setup;
          try {
            setup = await TemplateWalker.prepareTabForAuthoring({
              groundUrl, fragmentId: observationId,    // broadcast key only
              antecedentFragmentId: null, antecedentParamBindings: null,
              isAborted: () => false,
              existingTabId,
            });
          } catch (e) {
            Logger.error('background', `BEGIN_OBSERVATION_AUTHOR setup threw: ${e.message}`);
            chrome.runtime.sendMessage({
              type: 'OBSERVATION_AUTHOR_SETUP_RESULT',
              payload: { observationId, success: false, error: e.message, tabId: null },
            }).catch(() => {});
            sendResponse({ success: false, error: e.message });
            return;
          }
          if (!setup.success) {
            chrome.runtime.sendMessage({
              type: 'OBSERVATION_AUTHOR_SETUP_RESULT',
              payload: { observationId, success: false, error: setup.error, tabId: setup.tabId },
            }).catch(() => {});
            sendResponse({ success: false, error: setup.error });
            return;
          }

          chrome.runtime.sendMessage({
            type: 'OBSERVATION_AUTHOR_SETUP_RESULT',
            payload: { observationId, success: true, tabId: setup.tabId, error: null },
          }).catch(() => {});
          // v2.74.128 — Background-side per-tab map removed; see the
          // parallel cleanup in BEGIN_FRAGMENT_AUTHOR above.
          sendResponse({ success: true, tabId: setup.tabId });
        } catch (err) {
          Logger.error('background', `BEGIN_OBSERVATION_AUTHOR failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.72.95 (Phase 1) — Preview the value an Observation would
    // extract. Used by observation-author mode's Verify button. Does
    // NOT mutate the page — pure read.
    //
    // Modes:
    //   mode='value' attribute='text'      → element.textContent
    //   mode='value' attribute='html'      → element.outerHTML
    //   mode='value' attribute='<other>'   → element.getAttribute(other)
    //
    // Returns { success, value?, error? }
    case 'EXECUTE_OBSERVATION_PREVIEW': {
      (async () => {
        try {
          const { tabId, selector, mode = 'value', attribute = 'text' } = payload ?? {};
          if (!tabId || !selector) {
            sendResponse({ success: false, error: 'tabId + selector required' });
            return;
          }
          if (mode !== 'value') {
            sendResponse({ success: false, error: `Unsupported preview mode: "${mode}"` });
            return;
          }
          // Forward to content script's EXTRACT_VALUE. v2.72.95 adds
          // 'html' as a recognized attribute string (returns outerHTML).
          const res = await new Promise((resolve, reject) => {
            chrome.tabs.sendMessage(tabId, {
              type: 'EXTRACT_VALUE',
              payload: { selector, attribute },
            }, { frameId: 0 }, (response) => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(response);
            });
          });
          sendResponse(res ?? { success: false, error: 'EXTRACT_VALUE returned null' });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }

    // v2.72.95 (Phase 1) — Note: SAVE_OBSERVATION is handled by the
    // pre-existing case below (added in v2.72.0 Pass 3a). It uses
    // broadcastStorageChanged() with the canonical {type, kind, id,
    // action} top-level shape that all STORAGE_CHANGED listeners expect.
    // observation-author mode dispatches the same SAVE_OBSERVATION
    // message; no separate handler needed.

    // v2.74.19 (Ship E) — Image snap capture (free-extract). Used by
    // observation-author mode's Verify button on image_snap cards AND
    // by the runtime ExecutionEngine at execute time.
    //
    // Flow:
    //   1. Scroll the tab to payload.scrollY (if not already)
    //   2. Wait a frame for layout to settle
    //   3. chrome.tabs.captureVisibleTab → full-viewport PNG dataUrl
    //   4. Decode + crop to payload.rect (scaled by DPR if needed)
    //   5. Return { success, dataUrl } where dataUrl is the cropped image
    //
    // The captureVisibleTab API requires the activeTab permission OR
    // <all_urls> in host_permissions. Either is already granted by our
    // manifest.
    // v2.74.62 — Image (read) → Claude vision → list. The Observation
    // image_read shape's verify path:
    //   1. Crop the screenshot at ex.rect (reuses OBSERVE_IMAGE_SNAP_BG
    //      via direct chrome.tabs.captureVisibleTab + canvas crop).
    //   2. Send the cropped image + author's description to Claude's
    //      vision API (AnthropicService.readImage).
    //   3. Return { items[], dataUrl, width, height } so verify can
    //      show the thumbnail AND the Claude-distilled list.
    case 'OBSERVE_IMAGE_READ_BG': {
      // v2.74.145 — Delegates to Services/ImageReadCapture.performImageRead
      // so the same pipeline serves both this sidepanel-verify message
      // path and the runtime ExecutionEngine path (which now imports the
      // helper directly, avoiding the SW-self-messaging port-closed bug).
      (async () => {
        try {
          const result = await performImageRead(payload ?? {});
          sendResponse(result);
        } catch (err) {
          Logger.error('background', `OBSERVE_IMAGE_READ_BG failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.61 — Section → Claude → list. The Observation Section
    // extract shape's verify path: capture the section via the
    // content script, then ask Claude to distill it into a curated
    // list of text values (mode='text') or URLs (mode='url').
    // Returns { success, items, section } so the verify caller can
    // display the items AND keep the raw section data for record.
    case 'OBSERVE_SECTION_LIST_BG': {
      (async () => {
        try {
          const { tabId, target, mode, frameUrl } = payload ?? {};
          if (typeof tabId !== 'number' || !target) {
            sendResponse({ success: false, error: 'tabId + target required' });
            return;
          }
          // v2.74.199 — Resolve iframe routing. Picker captures frameUrl
          // (v2.74.198); verify dispatchers pass it through; this handler
          // resolves to a frameId via TemplateWalker._resolveFrameId
          // (falls back to top frame when frameUrl is empty or the
          // iframe is gone). Without this, every section-list verify on
          // an iframe-picked selector failed with "OBSERVE_SECTION: no
          // element matched ..." because the message hit the top frame's
          // document instead of the iframe's.
          const sectionFrameId = await TemplateWalker._resolveFrameId(tabId, frameUrl);
          // Step 1: capture the section via the content script.
          let sectionRes;
          try {
            sectionRes = await chrome.tabs.sendMessage(tabId, {
              type: 'OBSERVE_SECTION',
              payload: { target },
            }, { frameId: sectionFrameId });
          } catch (e) {
            sendResponse({ success: false, error: `Section capture failed: ${e.message}` });
            return;
          }
          if (!sectionRes?.success) {
            sendResponse({ success: false, error: sectionRes?.error ?? 'OBSERVE_SECTION returned no payload' });
            return;
          }
          const section = sectionRes.section ?? {};
          // Step 2: tab URL for relative-URL resolution.
          let sourceUrl = '';
          try {
            const tab = await chrome.tabs.get(tabId);
            sourceUrl = tab?.url ?? '';
          } catch { /* fine — Claude handles missing URLs */ }
          // Step 3: ask Claude.
          const llmRes = await AnthropicService.extractSectionItems({
            mode      : mode === 'url' ? 'url' : 'text',
            section,
            sourceUrl,
          });
          if (!llmRes) {
            sendResponse({ success: false, error: 'Claude returned no usable list' });
            return;
          }
          sendResponse({
            success: true,
            items  : llmRes.items,
            section,
          });
        } catch (err) {
          Logger.error('background', `OBSERVE_SECTION_LIST_BG failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.220 — Clipboard read via an offscreen document. Content
    // scripts can't reliably call navigator.clipboard.readText() during
    // sidepanel-initiated verify because their document lacks OS focus
    // (the side panel has focus). Offscreen documents created with
    // reasons:['CLIPBOARD'] bypass the focus requirement — they're the
    // canonical MV3 escape hatch.
    //
    // Lifecycle: create the offscreen doc on first request, reuse on
    // subsequent ones, never explicitly close (the SW going idle tears
    // it down). chrome.runtime.getContexts confirms whether one exists.
    // v2.74.227 — Install the clipboard writeText patch in the page's
    // main world. Required because pages like HubSpot's chat iframe
    // have CSP rules that block inline <script> injection from content
    // scripts. Extensions bypass page CSP via chrome.scripting.
    // executeScript({world:'MAIN'}), so we route the patch install
    // through background here.
    //
    // The patch intercepts navigator.clipboard.writeText AND
    // navigator.clipboard.write (the ClipboardItem-based API some apps
    // use for rich-format copies) and dispatches a custom event with
    // the captured text. Content script listens for the event after
    // clicking the copy button — bypasses the focus requirement on
    // the actual system clipboard write, which Chrome rejects when
    // the page document doesn't have OS focus.
    //
    // Idempotent: flag on `window` prevents double-patching across
    // repeated click_copy invocations.
    case 'INJECT_CLIPBOARD_PATCH_BG': {
      (async () => {
        try {
          const tabId = sender?.tab?.id;
          const frameId = sender?.frameId;
          if (typeof tabId !== 'number') {
            sendResponse({ success: false, error: 'INJECT_CLIPBOARD_PATCH_BG: sender.tab.id missing' });
            return;
          }
          await chrome.scripting.executeScript({
            target: {
              tabId,
              frameIds: typeof frameId === 'number' ? [frameId] : undefined,
            },
            world: 'MAIN',
            func: (eventName) => {
              if (window.__ahub_clipboard_patched === true) return;
              window.__ahub_clipboard_patched = true;
              try {
                const origWT = navigator.clipboard.writeText.bind(navigator.clipboard);
                navigator.clipboard.writeText = function(text) {
                  try {
                    window.dispatchEvent(new CustomEvent(eventName, { detail: String(text ?? '') }));
                  } catch (_) { /* dispatch failure: silent */ }
                  // Still call original so normal app behavior is
                  // preserved when focus is present.
                  try { return origWT(text); } catch (_) { return Promise.resolve(); }
                };
                // Also patch the ClipboardItem-based API. Some apps use
                // navigator.clipboard.write([new ClipboardItem({...})])
                // to copy multiple formats (text/plain + text/html).
                if (typeof navigator.clipboard.write === 'function') {
                  const origW = navigator.clipboard.write.bind(navigator.clipboard);
                  navigator.clipboard.write = async function(items) {
                    try {
                      for (const item of items || []) {
                        if (item.types && item.types.includes && item.types.includes('text/plain')) {
                          const blob = await item.getType('text/plain');
                          const t = await blob.text();
                          window.dispatchEvent(new CustomEvent(eventName, { detail: t }));
                          break;
                        }
                      }
                    } catch (_) { /* iteration failure: silent */ }
                    try { return origW(items); } catch (_) { return Promise.resolve(); }
                  };
                }
              } catch (_) { /* patching failed; don't break the page */ }
            },
            args: ['__ahub_clipboard_capture'],
          });
          sendResponse({ success: true });
        } catch (err) {
          Logger.warn?.('background', `INJECT_CLIPBOARD_PATCH_BG failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.229 — Selector refinement via Claude. The picker often
    // produces fragile selectors (positional, hashed classes); the
    // author's manual workflow has been: pick → verify → copy DOM →
    // ask Claude → paste back. This handler closes that loop in one
    // click. Payload includes the inspect report + shape; we call
    // AnthropicService.suggestSelector and return the candidate.
    // v2.74.235 — Wave 2 of the landmark SSOT project. Perspective-capture's
    // Pick flow forwards the full DOM context + screenshot + role +
    // rule-derived capabilities/operations to this handler, which calls
    // Claude once and returns the complete landmark profile (refined
    // selector + description + aliases + operationsCommon + pitfalls +
    // expectedContent + confidence). Persisted on the landmark record;
    // downstream consumers in Wave 3 read it without re-running Claude.
    // v2.74.236 — Wave 3 of the landmark SSOT project. Authoring UIs
    // (fragment-author, observation-author) call this to populate
    // landmark-picker dropdowns filtered by the action / shape's
    // required operation. Returns a flat list of landmark entries
    // ready for direct rendering.
    case 'LIST_LANDMARKS_FOR_GROUND': {
      (async () => {
        try {
          const { groundId, filterOp, includeMismatch } = payload ?? {};
          if (typeof groundId !== 'string' || !groundId) {
            sendResponse({ success: false, landmarks: [], error: 'groundId required' });
            return;
          }
          // v2.74.277 — listLandmarksForGround now statically imported.
          const landmarks = await listLandmarksForGround(groundId, { filterOp, includeMismatch });
          sendResponse({ success: true, landmarks });
        } catch (err) {
          Logger.warn('background', `LIST_LANDMARKS_FOR_GROUND failed: ${err.message}`);
          sendResponse({ success: false, landmarks: [], error: err.message });
        }
      })();
      return true;
    }

    // v2.74.240 — Phase 2 substrate registry CRUD. Sidepanel writes
    // each landmark to the registry directly during perspective save; reads
    // hydrate refs into full records at edit time. Same handler pattern
    // as perspective CRUD for symmetry.
    case 'SAVE_LANDMARK': {
      (async () => {
        try {
          const { landmark } = payload ?? {};
          if (!landmark?.uid) {
            sendResponse({ success: false, error: 'landmark.uid required' });
            return;
          }
          const saved = await StorageManager.saveLandmark(landmark);
          sendResponse({ success: true, landmark: saved });
        } catch (err) {
          Logger.warn('background', `SAVE_LANDMARK failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.266 — Partial landmark update. Used by drift-confirmation
    // UX (Phase 6.5 closure) to update proposedEffect when the author
    // accepts the observed value. Also usable by future surfaces for
    // lifecycle overrides, profile edits, etc.
    case 'UPDATE_LANDMARK': {
      (async () => {
        try {
          const { uid, patch } = payload ?? {};
          if (!uid)   { sendResponse({ success: false, error: 'uid required' });   return; }
          if (!patch || typeof patch !== 'object') {
            sendResponse({ success: false, error: 'patch object required' });
            return;
          }
          const updated = await StorageManager.updateLandmark(uid, patch);
          sendResponse({ success: true, landmark: updated });
        } catch (err) {
          Logger.warn('background', `UPDATE_LANDMARK failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'GET_LANDMARK': {
      (async () => {
        try {
          const { uid } = payload ?? {};
          if (!uid) { sendResponse({ success: false, error: 'uid required' }); return; }
          const landmark = await StorageManager.getLandmark(uid);
          sendResponse({ success: true, landmark });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'GET_LANDMARKS': {
      (async () => {
        try {
          const { uids } = payload ?? {};
          if (!Array.isArray(uids)) { sendResponse({ success: false, error: 'uids array required' }); return; }
          const landmarks = await StorageManager.getLandmarks(uids);
          sendResponse({ success: true, landmarks });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'DELETE_LANDMARK': {
      (async () => {
        try {
          const { uid } = payload ?? {};
          if (!uid) { sendResponse({ success: false, error: 'uid required' }); return; }
          const landmark = await StorageManager.getLandmark(uid);
          await deleteRecordWithSync('landmark', uid, () => StorageManager.deleteLandmark(uid), landmark?.groundId);
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.243 — Phase 5 substrate spec: blast-radius computation.
    // Authoring UIs call this BEFORE removing / deprecating a
    // landmark to warn the author about dependent perspectives / fragments
    // / observations. Returns the consumer list + summary counts.
    // v2.74.247 — Phase 7c substrate spec: perspective activation
    // evaluator. Sidepanel callers (Studio surfaces, drift detection)
    // ask "which perspectives are active given this page state?" The
    // runtime equivalent lives inside TemplateWalker; this handler
    // makes the same evaluator reachable from authoring UIs.
    case 'LIST_ACTIVE_PERSPECTIVES': {
      (async () => {
        try {
          const { groundId, tabUrl, tabId } = payload ?? {};
          if (!groundId) {
            sendResponse({ success: false, error: 'groundId required' });
            return;
          }
          let url = tabUrl;
          if (!url && typeof tabId === 'number') {
            try { url = (await chrome.tabs.get(tabId))?.url ?? ''; }
            catch { url = ''; }
          }
          // v2.74.277 — listActivePerspectives now statically imported.
          const perspectives = await listActivePerspectives(groundId, { tabUrl: url ?? '', tabId });
          sendResponse({
            success: true,
            tabUrl : url ?? null,
            // v2.74.275 — Legacy urlPattern field removed; URL gating
            // expressed via predicates (urlMatches kind).
            perspectives: perspectives.map(l => ({
              id: l.id, name: l.name,
              landmarkCount: Array.isArray(l.landmarkRefs) ? l.landmarkRefs.length : 0,
              iframeContextCount: Array.isArray(l.iframeContexts) ? l.iframeContexts.length : 0,
            })),
          });
        } catch (err) {
          Logger.warn('background', `LIST_ACTIVE_PERSPECTIVES failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'ANALYZE_LANDMARK_IMPACT': {
      (async () => {
        try {
          const { uid, groundId } = payload ?? {};
          if (!uid || !groundId) {
            sendResponse({ success: false, error: 'uid + groundId required' });
            return;
          }
          // v2.74.277 — analyzeLandmarkImpact now statically imported.
          const impact = await analyzeLandmarkImpact(uid, groundId);
          sendResponse({ success: true, impact });
        } catch (err) {
          Logger.warn('background', `ANALYZE_LANDMARK_IMPACT failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.249 — Phase 8: Ground event bus. Studio (and any other
    // surface) can read/clear the per-ground event log via these
    // handlers. Emit is primarily called engine-side (TemplateWalker)
    // but exposed here so UI surfaces can synthesize events (e.g.,
    // manual lifecycle overrides recorded as audit trail).
    case 'EMIT_GROUND_EVENT': {
      (async () => {
        try {
          const { groundId, event } = payload ?? {};
          if (!groundId || !event) {
            sendResponse({ success: false, error: 'groundId + event required' });
            return;
          }
          // v2.74.277 — emit statically imported as emitGroundEvent_bg.
          const entry = await emitGroundEvent_bg(groundId, event);
          sendResponse({ success: true, event: entry });
        } catch (err) {
          Logger.warn('background', `EMIT_GROUND_EVENT failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'LIST_GROUND_EVENTS': {
      (async () => {
        try {
          const { groundId, opts } = payload ?? {};
          if (!groundId) {
            sendResponse({ success: false, error: 'groundId required' });
            return;
          }
          // v2.74.277 — list statically imported as listGroundEvents_bg.
          const events = await listGroundEvents_bg(groundId, opts ?? {});
          sendResponse({ success: true, events });
        } catch (err) {
          Logger.warn('background', `LIST_GROUND_EVENTS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'CLEAR_GROUND_EVENTS': {
      (async () => {
        try {
          const { groundId } = payload ?? {};
          if (!groundId) {
            sendResponse({ success: false, error: 'groundId required' });
            return;
          }
          // v2.74.277 — clear statically imported as clearGroundEvents_bg.
          await clearGroundEvents_bg(groundId);
          sendResponse({ success: true });
        } catch (err) {
          Logger.warn('background', `CLEAR_GROUND_EVENTS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.252 — Phase 9: Landmark re-verification primitives.
    // Substrate primitive only; no automatic trigger (per spec dev
    // decision 2026-05-21). UI surfaces invoke explicitly.
    case 'VERIFY_LANDMARK': {
      (async () => {
        try {
          const { uid, tabId } = payload ?? {};
          if (!uid)                    { sendResponse({ success: false, error: 'uid required' });    return; }
          if (typeof tabId !== 'number') { sendResponse({ success: false, error: 'tabId required' });  return; }
          // v2.74.277 — verifyLandmark now statically imported.
          const result = await verifyLandmark(uid, tabId);
          sendResponse(result);
        } catch (err) {
          Logger.warn('background', `VERIFY_LANDMARK failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'VERIFY_STALE_SUSPECTED_ON_GROUND': {
      (async () => {
        try {
          const { groundId, tabId, scope } = payload ?? {};
          if (!groundId)               { sendResponse({ success: false, error: 'groundId required' }); return; }
          if (typeof tabId !== 'number') { sendResponse({ success: false, error: 'tabId required' });    return; }
          // v2.74.277 — verifyStaleSuspectedOnGround now statically imported.
          const result = await verifyStaleSuspectedOnGround(groundId, tabId, { scope });
          sendResponse(result);
        } catch (err) {
          Logger.warn('background', `VERIFY_STALE_SUSPECTED_ON_GROUND failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.254 — Phase 10: Landmark reference replacement. Symmetric
    // to ANALYZE_LANDMARK_IMPACT (Phase 5). Supports dryRun preview
    // so Studio can show "this would rewrite N fragments / M
    // observations / K perspective refs" before commit.
    case 'REPLACE_LANDMARK_REFERENCES': {
      (async () => {
        try {
          const { oldUid, newUid, groundId, dryRun } = payload ?? {};
          if (!oldUid || !newUid || !groundId) {
            sendResponse({ success: false, error: 'oldUid + newUid + groundId required' });
            return;
          }
          // v2.74.277 — replaceLandmarkReferences now statically imported.
          const result = await replaceLandmarkReferences(oldUid, newUid, groundId, { dryRun: dryRun === true });
          sendResponse(result);
        } catch (err) {
          Logger.warn('background', `REPLACE_LANDMARK_REFERENCES failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.255 — Phase 10.5: replacement candidate finder. Ranked
    // suggestions for which landmark to swap in when removing or
    // recovering from drift. Composes with REPLACE_LANDMARK_REFERENCES
    // (Phase 10) and ANALYZE_LANDMARK_IMPACT (Phase 5).
    case 'FIND_REPLACEMENT_CANDIDATES': {
      (async () => {
        try {
          const { uid, groundId, limit, includeWeak, minConfidence } = payload ?? {};
          if (!uid || !groundId) {
            sendResponse({ success: false, error: 'uid + groundId required' });
            return;
          }
          // v2.74.277 — findReplacementCandidates now statically imported.
          const result = await findReplacementCandidates(uid, groundId, { limit, includeWeak, minConfidence });
          sendResponse(result);
        } catch (err) {
          Logger.warn('background', `FIND_REPLACEMENT_CANDIDATES failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.236 — Authoring-time resolver. The sidepanel uses this
    // when an author selects a landmark from the dropdown — we resolve
    // the ref immediately so the UI can populate the selector preview
    // and verify it. Runtime resolution happens engine-side via
    // applyLandmarkRefToStep (not this handler).
    case 'RESOLVE_LANDMARK_REF': {
      (async () => {
        try {
          const { ref } = payload ?? {};
          // v2.74.277 — resolveLandmarkRef now statically imported.
          const resolved = await resolveLandmarkRef(ref);
          sendResponse({
            success : true,
            selector: resolved.selector,
            frameUrl: resolved.frameUrl,
            landmark: resolved.landmark,
            perspective  : { id: resolved.perspective.id, name: resolved.perspective.name },
          });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'GENERATE_LANDMARK_PROFILE_BG': {
      (async () => {
        try {
          const {
            role, currentSelector,
            fingerprint, outerHTMLPreview, parentOuterHTMLPreview,
            frame, matchedCount, screenshotDataUrl, operationsAllowed,
          } = payload ?? {};
          // v2.74.291 — Diagnostic at the message-passing boundary.
          // chrome.runtime.sendMessage JSON-serializes payloads; multi-MB
          // base64 strings have failed silently in the past. Log the
          // arriving size so we can detect drop here vs. at the call site.
          Logger.info('background', `GENERATE_LANDMARK_PROFILE_BG — screenshotDataUrl arrived: ${screenshotDataUrl ? `string (${screenshotDataUrl.length} chars)` : 'null/absent'}, matchedCount=${matchedCount}`);
          const res = await AnthropicService.generateLandmarkProfile({
            role, currentSelector,
            fingerprint, outerHTMLPreview, parentOuterHTMLPreview,
            frame, matchedCount, screenshotDataUrl, operationsAllowed,
          });
          sendResponse(res);
        } catch (err) {
          Logger.warn('background', `GENERATE_LANDMARK_PROFILE_BG failed: ${err.message}`);
          sendResponse({ success: false, profile: null, error: err.message });
        }
      })();
      return true;
    }

    case 'ASK_CLAUDE_FOR_SELECTOR_BG': {
      (async () => {
        try {
          const {
            shape, currentSelector,
            matchCount, matchIndex, pickLastUsed,
            outerHTMLPreview, parentOuterHTMLPreview,
            frame,
            // v2.74.233 — Optional cropped screenshot of the picked
            // element region (perspective-landmark Pick flow uses this).
            screenshotDataUrl,
          } = payload ?? {};
          const res = await AnthropicService.suggestSelector({
            shape, currentSelector,
            matchCount, matchIndex, pickLastUsed,
            outerHTMLPreview, parentOuterHTMLPreview,
            frame,
            screenshotDataUrl,
          });
          sendResponse(res);
        } catch (err) {
          Logger.warn('background', `ASK_CLAUDE_FOR_SELECTOR_BG failed: ${err.message}`);
          sendResponse({ success: false, selector: '', error: err.message });
        }
      })();
      return true;
    }

    case 'CLIPBOARD_READ_BG': {
      (async () => {
        try {
          // Ensure offscreen document exists.
          const existing = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
          });
          if (!existing || existing.length === 0) {
            await chrome.offscreen.createDocument({
              url: 'offscreen.html',
              reasons: ['CLIPBOARD'],
              justification: 'Reading clipboard for click_copy extract shape',
            });
          }
          // Ask the offscreen doc to read the clipboard. chrome.runtime.
          // sendMessage broadcasts to every extension context that
          // registered onMessage; only the offscreen handler responds
          // (it filters by type), and the background's own onMessage
          // handler doesn't have an OFFSCREEN_READ_CLIPBOARD case so
          // it ignores the broadcast.
          const res = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_READ_CLIPBOARD' });
          if (!res) {
            sendResponse({ success: false, error: 'offscreen did not respond to clipboard read' });
            return;
          }
          sendResponse(res);
        } catch (err) {
          Logger.error('background', `CLIPBOARD_READ_BG failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.51 — Full-tab screenshot (image_full shape). Same idea as
    // OBSERVE_IMAGE_SNAP_BG but no scroll, no crop — just
    // chrome.tabs.captureVisibleTab on the active viewport and return
    // the data URL.
    case 'OBSERVE_IMAGE_FULL_BG': {
      // v2.74.146 — Delegates to Services/ImageReadCapture.performImageFull
      // so the same pipeline serves both this sidepanel-verify message
      // path and the runtime ExecutionEngine path (which now imports the
      // helper directly, avoiding SW-self-messaging).
      (async () => {
        try {
          const result = await performImageFull(payload ?? {});
          sendResponse(result);
        } catch (err) {
          Logger.error('background', `OBSERVE_IMAGE_FULL_BG failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
    case 'OBSERVE_IMAGE_SNAP_BG': {
      // v2.74.146 — Delegates to Services/ImageReadCapture.performImageSnap
      // for the same reason as the FULL handler above.
      (async () => {
        try {
          const result = await performImageSnap(payload ?? {});
          sendResponse(result);
        } catch (err) {
          Logger.warn?.('background', `OBSERVE_IMAGE_SNAP_BG failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }



    //
    // Used by fragment-author mode's per-row Verify button. Dispatches
    // to the same content-script EXECUTE_STEP / WAIT_FOR_ELEM paths
    // TemplateWalker uses during T3 walks. For NAVIGATE we use
    // chrome.tabs.update; for WAIT we sleep server-side; for everything
    // else we forward to the content script.
    //
    // Returns { success, error?, info? }.
    case 'EXECUTE_AUTHORING_STEP': {
      (async () => {
        try {
          const { tabId, step } = payload ?? {};
          if (!tabId || !step?.action) {
            sendResponse({ success: false, error: 'tabId and step.action required' });
            return;
          }
          // v2.74.163 — Same-origin iframe support for verify. When the
          // step was picked inside an iframe, the picker captured the
          // iframe's URL into step.frameUrl. Re-resolve to the current
          // frameId (frame ids aren't stable across reloads) and route
          // EXECUTE_STEP / WAIT_FOR_ELEM into that frame. Top-frame
          // actions resolve to TOP_FRAME_ID (= 0) and behave as before.
          const verifyFrameId = await TemplateWalker._resolveFrameId(tabId, step.frameUrl);

          // NAVIGATE: chrome.tabs.update. Wait for tab complete before resolving.
          if (step.action === 'NAVIGATE') {
            try {
              await new Promise((resolve, reject) => {
                chrome.tabs.update(tabId, { url: step.value }, () => {
                  if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                  else resolve();
                });
              });
              await __waitForTabComplete(tabId, 8000);
              // Re-inject content script after navigation (the new page lost it).
              // v2.74.166 — allFrames: true so iframes in the new page
              // also get the content script. The manifest's auto-inject
              // covers iframes that load AFTER, but iframes that arrive
              // synchronously with the top page need this re-inject too
              // for the picker to reach them on subsequent operations.
              try {
                await chrome.scripting.executeScript({
                  target: { tabId, allFrames: true },
                  files: ['ContentScripts/contentScript.js'],
                });
              } catch { /* fine */ }
              sendResponse({ success: true, info: `navigated to ${step.value}` });
            } catch (e) {
              sendResponse({ success: false, error: `NAVIGATE failed: ${e.message}` });
            }
            return;
          }

          // WAIT: server-side sleep. v2.74.758 — optional `jitter` adds a random 0..jitter ms so a paced replay's
          // cadence differs each run (a constant delay is itself a bot-detection signature). No jitter → exact.
          if (step.action === 'WAIT') {
            const base = Number(step.value) || 0;
            const jitter = Number(step.jitter) || 0;
            const ms = base + (jitter > 0 ? Math.floor(Math.random() * jitter) : 0);
            await new Promise(r => setTimeout(r, ms));
            sendResponse({ success: true, info: `waited ${ms}ms` });
            return;
          }

          // WAIT_FOR: forward to content script's WAIT_FOR_ELEM.
          if (step.action === 'WAIT_FOR') {
            try {
              const res = await new Promise((resolve, reject) => {
                chrome.tabs.sendMessage(tabId, {
                  type: 'WAIT_FOR_ELEM',
                  payload: { selector: step.selector, timeoutMs: 10000 },
                }, { frameId: verifyFrameId }, (response) => {
                  if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                  else resolve(response);
                });
              });
              sendResponse(res ?? { success: false, error: 'WAIT_FOR returned null' });
            } catch (e) {
              sendResponse({ success: false, error: `WAIT_FOR failed: ${e.message}` });
            }
            return;
          }

          // v2.74.200 — WAIT_FOR_GONE: poll until selector disappears.
          // Inline polling loop using CHECK_ELEMENT (mirrors
          // TemplateWalker.#waitForElementGone). timeoutMs from
          // step.value, default 30000. Frame-aware via verifyFrameId.
          // Verify uses a shorter default (15000) so the authoring
          // session doesn't block for half a minute on a typo'd
          // selector that never disappears.
          if (step.action === 'WAIT_FOR_GONE') {
            const requested = parseInt(step.value, 10);
            const timeoutMs = Number.isFinite(requested) && requested > 0
              ? Math.min(requested, 60000)   // cap verify-time waits at 60s
              : 15000;                       // verify default
            const start = Date.now();
            const POLL_MS = 400;
            let cleared = false;
            let lastError = null;
            try {
              while (Date.now() - start < timeoutMs) {
                let resp;
                try {
                  resp = await new Promise((resolve, reject) => {
                    chrome.tabs.sendMessage(tabId, {
                      type: 'CHECK_ELEMENT',
                      payload: { selector: step.selector },
                    }, { frameId: verifyFrameId }, (response) => {
                      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                      else resolve(response);
                    });
                  });
                } catch (e) {
                  // Frame gone counts as cleared.
                  lastError = e?.message;
                  cleared = true;
                  break;
                }
                if (!resp?.found) {
                  cleared = true;
                  break;
                }
                await new Promise(r => setTimeout(r, POLL_MS));
              }
              if (cleared) {
                const elapsed = Date.now() - start;
                sendResponse({ success: true, info: `gone after ${elapsed}ms${lastError ? ` (frame error: ${lastError})` : ''}` });
              } else {
                sendResponse({
                  success: false,
                  error  : `WAIT_FOR_GONE: "${(step.selector ?? '').slice(0, 120)}" still present after ${timeoutMs}ms`,
                });
              }
            } catch (e) {
              sendResponse({ success: false, error: `WAIT_FOR_GONE failed: ${e.message}` });
            }
            return;
          }

          // CLICK / CLICK_BY_LABEL / TYPE / SELECT / BLUR / SCROLL_TO —
          // forward to EXECUTE_STEP.
          // v2.72.72 — SCROLL_TO carries an optional smoothScroll bool.
          // Forwarded as part of payload; content script's handleScrollTo
          // picks up the behavior flag.
          //
          // CLICK / CLICK_BY_LABEL special-case: a click can trigger a
          // navigation (same tab) or open a new tab. In either case the
          // content script may not get a chance to send its response
          // before being unloaded (same-tab nav) or the action's "result"
          // is on a different tab (new tab). To handle this, we set up
          // chrome.webNavigation + chrome.tabs.onCreated listeners scoped
          // to this tabId BEFORE dispatching, and treat either firing
          // within 3s as a success signal even if EXECUTE_STEP returns
          // an error.
          // v2.72.91 — CLICK_BY_LABEL fires a click on an option which
          // may navigate (e.g. clicking a link inside a menu). Same
          // rescue applies — treat both as clicking actions.
          if (step.action === 'CLICK' || step.action === 'CLICK_BY_LABEL') {
            try {
              // v2.74.163 — Pass verifyFrameId through to the click
              // helper. The helper dispatches CLICK / CLICK_BY_LABEL
              // into the resolved frame and watches for navigation
              // events on the tab (frame-agnostic) so click semantics
              // work the same in iframes as in the top frame.
              // v2.74.322 — Wrap the click in the observation bracket so we
              // ALSO capture the DOM-shape signal (observedInteractionPattern)
              // — e.g. a custom dropdown opening — alongside the nav/new-tab
              // detection below. The bracket (observeActionBracket) was built
              // for exactly this but was never wired into Verify, so a click
              // that opened a menu reported only "effect: none" with no hint
              // the menu was noticed. settleMs is small because
              // __executeClickWithNavObservation already waits out its 3s nav
              // window, so any menu is long open by the time END snapshots.
              const { actionResult: res, observation } = await observeActionBracket(
                tabId, verifyFrameId,
                () => __executeClickWithNavObservation(tabId, step, verifyFrameId),
                { settleMs: 150 },
              );
              // v2.74.312 — Verify-time effect observation. The click
              // helper already detects navigation + new-tab and encodes
              // it in res.info (and that detection survives page
              // teardown, which a fresh MutationObserver bracket would
              // not). Derive the observed substrate effect from those
              // signals and compare against the action's declared
              // effect so the author sees drift BEFORE save.
              //
              // Coverage: triggers-navigation + opens-new-thread are
              // observable here. triggers-modal (Phase 5 deferred) and
              // triggers-download (not tracked at verify) are not — for
              // those declared kinds we report observedEffect=null
              // ('not observable at verify time') rather than a false
              // 'none', so we don't flag spurious drift.
              const info = (res?.info ?? '').toLowerCase();
              let observedEffect;
              if (info.includes('opened new tab')) {
                observedEffect = { kind: 'opens-new-thread', form: 'tab' };
              } else if (info.includes('navigated')) {
                observedEffect = { kind: 'triggers-navigation' };
              } else {
                observedEffect = { kind: 'none' };
              }
              const declaredEffect = (step.effect && step.effect.kind) ? step.effect : { kind: 'none' };
              // Don't claim drift for effects we can't observe at verify
              // time (modal/download). Mark them inconclusive instead.
              const unobservableKinds = new Set(['triggers-modal', 'triggers-download']);
              let severity = null;
              let observable = true;
              if (unobservableKinds.has(declaredEffect.kind) && observedEffect.kind === 'none') {
                observable = false;   // can't confirm; not a mismatch
              } else {
                severity = classifyEffectDrift(declaredEffect, observedEffect);
              }
              res.effectObservation = {
                declaredEffect,
                observedEffect: observable ? observedEffect : null,
                severity,
                observable,
                // v2.74.322 — DOM-shape pattern from the bracket (our intel
                // layer, distinct from the spec effect). null when the page
                // navigated away before END could snapshot.
                observedInteractionPattern: observation?.observedInteractionPattern ?? null,
              };
              sendResponse(res);
            } catch (e) {
              sendResponse({ success: false, error: `${step.action} failed: ${e.message}` });
            }
            return;
          }
          try {
            const res = await new Promise((resolve, reject) => {
              chrome.tabs.sendMessage(tabId, {
                type: 'EXECUTE_STEP',
                payload: {
                  action: step.action,
                  selector: step.selector,
                  value: step.value,
                  smoothScroll: step.smoothScroll === true,
                  // v2.74.316 — KEY repeat count for verify-time dispatch.
                  repeat: step.repeat,
                },
              }, { frameId: verifyFrameId }, (response) => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(response);
              });
            });
            sendResponse(res ?? { success: false, error: 'EXECUTE_STEP returned null' });
          } catch (e) {
            sendResponse({ success: false, error: `${step.action} failed: ${e.message}` });
          }
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.72.67 — Evaluate all of a Ground's named predicates (perspectives +
    // assertions) against the current page state of a tab. Returns the
    // ones that hold (match the page right now). Used by fragment-author
    // mode for auto-capturing preconditions at mount and postconditions
    // at save / per-Verify.
    //
    // Method: each perspective becomes a {perspective_ref} assertion; each
    // assertion is itself an assertion. Each is evaluated via
    // TemplateWalker.checkConditions against the live tab. Matching
    // ones are returned by id+name.
    //
    // Returns:
    //   {
    //     success: true,
    //     matchingPerspectives:    [{ id, name, urlPattern, landmarkCount }, ...],
    //     matchingAssertions: [{ id, name }, ...],
    //     urlPattern: string|null,   // ground.urlPattern as a precondition baseline
    //     evaluatedCount: { perspectives: N, assertions: N },
    //   }
    case 'EVALUATE_GROUND_PREDICATES': {
      (async () => {
        try {
          const { tabId, groundId } = payload ?? {};
          if (!tabId || !groundId) {
            sendResponse({ success: false, error: 'tabId and groundId required' });
            return;
          }

          const ground = await StorageManager.getGround(groundId);
          if (!ground) {
            sendResponse({ success: false, error: `Ground ${groundId} not found` });
            return;
          }

          const allPerspectives    = await StorageManager.listPerspectives(groundId);
          const allAssertions = await StorageManager.listAssertions(groundId);

          // Evaluate each perspective via perspective_ref. Matches if URL pattern
          // matches AND every landmark's selector resolves on the page.
          const matchingPerspectives = [];
          for (const loc of allPerspectives) {
            // v2.74.335 — PERSPECTIVE_SPEC § 12: deprecated Perspectives are not active
            // (retired perspectives don't contribute to the active set).
            if (loc?.lifecycle === 'deprecated') continue;
            try {
              const probe = await TemplateWalker.checkConditions({
                tabId,
                conditions: { match: 'all', conditions: [{ type: 'perspective_ref', perspectiveId: loc.id }] },
                timeoutMs: 0,
              });
              if (probe.ok) {
                // v2.74.275 — urlPattern removed; landmarkRefs[] is canonical.
                matchingPerspectives.push({
                  id: loc.id,
                  name: loc.name,
                  landmarkCount: (loc.landmarkRefs ?? []).length,
                });
              }
            } catch (e) {
              Logger.warn('background', `EVALUATE_GROUND_PREDICATES: perspective ${loc.id} eval threw: ${e.message}`);
            }
          }

          // Evaluate each assertion via assertion_ref. Note the assertion
          // object IS the conditions arg directly; checkConditions accepts
          // an assertion or a conditions array.
          const matchingAssertions = [];
          for (const ast of allAssertions) {
            try {
              const probe = await TemplateWalker.checkConditions({
                tabId,
                conditions: { match: 'all', conditions: [{ type: 'assertion_ref', assertionId: ast.id }] },
                timeoutMs: 0,
              });
              if (probe.ok) {
                matchingAssertions.push({ id: ast.id, name: ast.name });
              }
            } catch (e) {
              Logger.warn('background', `EVALUATE_GROUND_PREDICATES: assertion ${ast.id} eval threw: ${e.message}`);
            }
          }

          // v2.72.68 — Get the live tab URL so callers can capture
          // URL-aware conditions. The Ground's static urlPattern is
          // returned separately as a baseline reference; the caller
          // (fragment-author mode) uses the live URL for postconditions
          // (which need to reflect actual navigation) and either the
          // live URL or the ground pattern for preconditions depending
          // on context.
          let currentUrl = null;
          try {
            const tab = await new Promise((resolve, reject) => {
              chrome.tabs.get(tabId, (t) => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(t);
              });
            });
            currentUrl = tab?.url ?? null;
          } catch (e) {
            Logger.warn('background', `EVALUATE_GROUND_PREDICATES: tabs.get threw: ${e.message}`);
          }

          sendResponse({
            success: true,
            matchingPerspectives,
            matchingAssertions,
            currentUrl,
            urlPattern: ground.urlPattern ?? ground.url ?? null,
            evaluatedCount: { perspectives: allPerspectives.length, assertions: allAssertions.length },
          });
        } catch (err) {
          Logger.error('background', `EVALUATE_GROUND_PREDICATES failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.22 — ABORT_FRAGMENT_WALK handler removed. AI-walked path is gone.

    case 'SAVE_FRAGMENT': {
      (async () => {
        try {
          const { fragment } = payload;
          if (!fragment?.id || !fragment?.groundId) {
            sendResponse({ success: false, error: 'Fragment requires { id, groundId }' });
            return;
          }
          await StorageManager.saveFragment(fragment);
          broadcastStorageChanged('fragment', fragment.id, 'saved');
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `SAVE_FRAGMENT failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.72.67 — Load a single Fragment by id. Used by fragment-author
    // mode for antecedent inheritance (preconditions ← antecedent's
    // postconditions).
    case 'GET_FRAGMENT': {
      (async () => {
        try {
          const { fragmentId } = payload ?? {};
          if (!fragmentId) {
            sendResponse({ success: false, error: 'fragmentId required' });
            return;
          }
          const fragment = await StorageManager.getFragment(fragmentId);
          if (!fragment) {
            sendResponse({ success: false, error: `Fragment ${fragmentId} not found` });
            return;
          }
          sendResponse({ success: true, fragment });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'DELETE_FRAGMENT': {
      (async () => {
        try {
          const { fragmentId } = payload;
          const fragment = await StorageManager.getFragment(fragmentId);
          await deleteRecordWithSync('fragment', fragmentId, () => StorageManager.deleteFragment(fragmentId), fragment?.groundId);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `DELETE_FRAGMENT failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'UPDATE_FRAGMENT': {
      (async () => {
        try {
          const { fragmentId, patch } = payload;
          const updated = await StorageManager.updateFragment(fragmentId, patch);
          broadcastStorageChanged('fragment', fragmentId, 'saved');
          sendResponse({ success: true, fragment: updated });
        } catch (err) {
          Logger.error('background', `UPDATE_FRAGMENT failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ── Soft-delete + reference impact (STORAGE_SCHEMA §9/§10) ──────────────
    // deprecate is the DEFAULT reversible delete: it flips the record's lifecycle
    // to 'deprecated' and re-saves, so broadcastStorageChanged(...,'saved') both
    // refreshes the UI and rides it out to cloud as an ordinary update (no tombstone).
    // Hard delete (DELETE_*) is unchanged. Kinds: ground|fragment|observation|
    // analysis|assertion|perspective|landmark|strategy.
    case 'DEPRECATE_PRIMITIVE': {
      (async () => {
        try {
          const { kind, id } = payload;
          const updated = await StorageManager.deprecatePrimitive(kind, id);
          if (updated) broadcastStorageChanged(kind, id, 'saved');
          sendResponse({ success: !!updated, lifecycle: updated?.metadata?.lifecycle ?? updated?.lifecycle ?? null });
        } catch (err) {
          Logger.error('background', `DEPRECATE_PRIMITIVE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'RESTORE_PRIMITIVE': {
      (async () => {
        try {
          const { kind, id } = payload;
          const updated = await StorageManager.restorePrimitive(kind, id);
          if (updated) broadcastStorageChanged(kind, id, 'saved');
          sendResponse({ success: !!updated, lifecycle: updated?.metadata?.lifecycle ?? updated?.lifecycle ?? null });
        } catch (err) {
          Logger.error('background', `RESTORE_PRIMITIVE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // "What breaks if I delete this?" — the §10 pre-hard-delete check for any kind.
    // Returns { inboundRefs[], cascadeTargets[], blockers[] }; the UI confirms when non-empty.
    case 'ANALYZE_DELETION_IMPACT': {
      (async () => {
        try {
          const { id, groundId, computeCascade } = payload;
          const impact = await analyzeDeletionImpact(id, { groundId, computeCascade: computeCascade !== false });
          sendResponse({ success: true, impact });
        } catch (err) {
          Logger.error('background', `ANALYZE_DELETION_IMPACT failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ── Publications (STORAGE_SCHEMA §9) ───────────────────────────────────
    // Local publish→import round-trip. Registry upload/fetch is a later slice;
    // IMPORT_PUBLICATION resolves a package by explicit `package`, or by id from
    // the local outgoing store (same-device round-trip for testing).
    case 'PUBLISH_PRIMITIVE': {
      (async () => {
        try {
          const { kind, id, details } = payload;
          const publication = await publishPrimitive(kind, id, details || {});
          sendResponse({ success: true, publication });
        } catch (err) {
          Logger.error('background', `PUBLISH_PRIMITIVE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'LIST_OUTGOING_PUBLICATIONS': {
      (async () => {
        try { sendResponse({ success: true, publications: await listOutgoingPublications() }); }
        catch (err) { sendResponse({ success: false, error: err.message }); }
      })();
      return true;
    }

    case 'LIST_INCOMING_PUBLICATIONS': {
      (async () => {
        try { sendResponse({ success: true, publications: await listIncomingPublications() }); }
        catch (err) { sendResponse({ success: false, error: err.message }); }
      })();
      return true;
    }

    case 'IMPORT_PUBLICATION': {
      (async () => {
        try {
          const { publicationId, package: pkgArg, targetGroundId } = payload;
          // Resolve the package: explicit, local outgoing (same-device round-trip), then registry.
          let pkg = pkgArg || (publicationId ? await getOutgoingPublication(publicationId) : null);
          if (!pkg?.manifest && publicationId) {
            try { pkg = await fetchPublication(publicationId); }
            catch (e) { Logger.warn('background', `registry fetch ${publicationId}: ${e.message}`); }
          }
          if (!pkg?.manifest) { sendResponse({ success: false, error: 'publication package not found' }); return; }
          const result = await importPublicationPackage(pkg, { targetGroundId });
          if (result.ok) {
            // Refresh UI + nudge sync to push the newly-installed primitives (bootstrap also covers it).
            const groundId = targetGroundId || result.plan?.idMap?.[pkg.manifest.primary.primitiveId];
            if (groundId) broadcastStorageChanged('ground', groundId, 'saved');
          }
          sendResponse({ success: result.ok, ...result });
        } catch (err) {
          Logger.error('background', `IMPORT_PUBLICATION failed: ${err.message}`);
          sendResponse({ success: false, ok: false, error: err.message });
        }
      })();
      return true;
    }

    // Registry search/browse (AWS_INTEGRATION §7.4). Returns the registry's public listing.
    case 'SEARCH_PUBLICATIONS': {
      (async () => {
        try {
          const res = await searchPublications(payload?.query || '');
          sendResponse({ success: true, publications: res?.publications || [] });
        } catch (err) {
          Logger.warn('background', `SEARCH_PUBLICATIONS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message, publications: [] });
        }
      })();
      return true;
    }

    // Lineage update check for an imported publication (DD-12 B). Stamps updateNotifications.
    case 'CHECK_PUBLICATION_UPDATES': {
      (async () => {
        try {
          const { publicationId } = payload;
          if (!publicationId) { sendResponse({ success: false, error: 'publicationId required' }); return; }
          const res = await checkForUpdates(publicationId);
          sendResponse({ success: res.ok, ...res });
        } catch (err) {
          Logger.error('background', `CHECK_PUBLICATION_UPDATES failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // Apply an available update: import the newer version as a fresh incoming record (§9).
    case 'APPLY_PUBLICATION_UPDATE': {
      (async () => {
        try {
          const { fromPublicationId, toPublicationId, targetGroundId } = payload;
          const res = await applyUpdate(fromPublicationId, toPublicationId, { targetGroundId });
          if (res.ok && res.installedIds?.length) broadcastStorageChanged('publication', toPublicationId, 'imported');
          sendResponse({ success: res.ok, ...res });
        } catch (err) {
          Logger.error('background', `APPLY_PUBLICATION_UPDATE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ── Shared workspaces (DD-05 C / AWS_INTEGRATION §7.2) ─────────────────────
    // Team workspace management. Object sync into team grounds lands in a later slice.
    case 'CREATE_WORKSPACE': {
      (async () => {
        try { sendResponse({ success: true, workspace: await createWorkspace(payload?.name) }); }
        catch (err) { Logger.warn('background', `CREATE_WORKSPACE: ${err.message}`); sendResponse({ success: false, error: err.message }); }
      })();
      return true;
    }
    case 'LIST_WORKSPACES': {
      (async () => {
        try { const r = await listWorkspaces(); sendResponse({ success: true, workspaces: r?.workspaces || [] }); }
        catch (err) { sendResponse({ success: false, error: err.message, workspaces: [] }); }
      })();
      return true;
    }
    case 'GET_WORKSPACE': {
      (async () => {
        try { sendResponse({ success: true, workspace: await getWorkspace(payload?.workspaceId) }); }
        catch (err) { sendResponse({ success: false, error: err.message }); }
      })();
      return true;
    }
    case 'RENAME_WORKSPACE': {
      (async () => {
        try { await renameWorkspace(payload?.workspaceId, payload?.name); sendResponse({ success: true }); }
        catch (err) { sendResponse({ success: false, error: err.message }); }
      })();
      return true;
    }
    case 'ADD_WORKSPACE_MEMBER': {
      (async () => {
        try { await addWorkspaceMember(payload?.workspaceId, payload?.orchardUserId, payload?.role); sendResponse({ success: true }); }
        catch (err) { Logger.warn('background', `ADD_WORKSPACE_MEMBER: ${err.message}`); sendResponse({ success: false, error: err.message }); }
      })();
      return true;
    }
    case 'REMOVE_WORKSPACE_MEMBER': {
      (async () => {
        try { await removeWorkspaceMember(payload?.workspaceId, payload?.orchardUserId); sendResponse({ success: true }); }
        catch (err) { sendResponse({ success: false, error: err.message }); }
      })();
      return true;
    }
    // Local groundId → wsId registry (which grounds are team grounds). UI badges + workspace listing.
    case 'GET_GROUND_WORKSPACES': {
      (async () => {
        try { sendResponse({ success: true, map: await getGroundWorkspaceMap() }); }
        catch (err) { sendResponse({ success: false, error: err.message, map: {} }); }
      })();
      return true;
    }

    // ── Runtime trace archive (DD-15 B) ────────────────────────────────────────
    // Opt-in upload of a scrubbed test-run bundle for support/debug. Not part of sync.
    case 'ARCHIVE_EXECUTION': {
      (async () => {
        try {
          let result = null;
          if (payload?.jobId) {
            const recent = await StorageManager.getRecentResults(200);
            result = recent.find((r) => r.jobId === payload.jobId) || null;
          } else {
            result = (await StorageManager.getRecentResults(1))[0] || null;
          }
          if (!result) { sendResponse({ success: false, error: 'no test result to archive' }); return; }
          const executionId = String(result.jobId || `run_${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
          const res = await archiveExecution(executionId, _scrubForArchive(result));
          sendResponse({ success: true, executionId, ...res });
        } catch (err) {
          Logger.warn('background', `ARCHIVE_EXECUTION: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
    case 'GET_EXECUTION_ARCHIVE': {
      (async () => {
        try { sendResponse({ success: true, archive: await getExecutionArchive(payload?.executionId) }); }
        catch (err) { sendResponse({ success: false, error: err.message }); }
      })();
      return true;
    }
    case 'DELETE_EXECUTION_ARCHIVE': {
      (async () => {
        try { await deleteExecutionArchive(payload?.executionId); sendResponse({ success: true }); }
        catch (err) { sendResponse({ success: false, error: err.message }); }
      })();
      return true;
    }

    // ╔══════════════════════════════════════════════════════════════════════╗
    // ║ Pass M2 — ASSERTION LIBRARY                                          ║
    // ╚══════════════════════════════════════════════════════════════════════╝

    // v2.74.53 — Begin handlers for the Ground sidepanel's + Assert /
    // + Analyze buttons. Mirror BEGIN_PERSPECTIVE_CAPTURE's minimal shape:
    // set the sidepanel mode with payload; the mode itself mounts and
    // owns its lifecycle.
    case 'BEGIN_ASSERTION_AUTHOR': {
      const { groundId, existingTabId = null, returnTo = null, prefilledAssertion = null } = payload ?? {};
      if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return false; }
      __setSidepanelMode('assertion-author', {
        groundId,
        tabId: existingTabId,
        existingTabId,
        returnTo,
        prefilledAssertion,
      });
      sendResponse({ success: true });
      return false;
    }
    case 'BEGIN_ANALYSIS_AUTHOR': {
      const { groundId, existingTabId = null, returnTo = null, prefilledAnalysis = null } = payload ?? {};
      if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return false; }
      __setSidepanelMode('analysis-author', {
        groundId,
        tabId: existingTabId,
        existingTabId,
        returnTo,
        prefilledAnalysis,
      });
      sendResponse({ success: true });
      return false;
    }
    // v2.74.53 — Analysis save handler. Previously only Studio's
    // AnalysisForm called StorageManager.saveAnalysis directly; the
    // sidepanel mode needs a message-routed equivalent.
    case 'SAVE_ANALYSIS': {
      (async () => {
        try {
          const { analysis } = payload;
          if (!analysis?.id || !analysis?.groundId) {
            sendResponse({ success: false, error: 'Analysis requires { id, groundId }' });
            return;
          }
          await StorageManager.saveAnalysis(analysis);
          broadcastStorageChanged('analysis', analysis.id, 'saved');
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `SAVE_ANALYSIS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'SAVE_ASSERTION': {
      (async () => {
        try {
          const { assertion } = payload;
          if (!assertion?.id || !assertion?.groundId) {
            sendResponse({ success: false, error: 'Assertion requires { id, groundId }' });
            return;
          }
          await StorageManager.saveAssertion(assertion);
          broadcastStorageChanged('assertion', assertion.id, 'saved');
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `SAVE_ASSERTION failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.72.0 (Pass 3a) — Observation save/delete handlers. Mirrors the
    // SAVE_ASSERTION pattern. Broadcast is fire-and-forget so future
    // runtime/consumer code can listen for changes.
    case 'SAVE_OBSERVATION': {
      (async () => {
        try {
          const { observation } = payload;
          if (!observation?.id || !observation?.groundId) {
            sendResponse({ success: false, error: 'Observation requires { id, groundId }' });
            return;
          }
          await StorageManager.saveObservation(observation);
          broadcastStorageChanged('observation', observation.id, 'saved');
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `SAVE_OBSERVATION failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'DELETE_OBSERVATION': {
      (async () => {
        try {
          const { observationId } = payload;
          const observation = await StorageManager.getObservation(observationId);
          await deleteRecordWithSync('observation', observationId, () => StorageManager.deleteObservation(observationId), observation?.groundId);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `DELETE_OBSERVATION failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'LIST_ASSERTIONS': {
      (async () => {
        try {
          const { groundId } = payload;
          const assertions = await StorageManager.listAssertions(groundId);
          sendResponse({ success: true, assertions });
        } catch (err) {
          Logger.error('background', `LIST_ASSERTIONS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'GET_ASSERTION': {
      (async () => {
        try {
          const { assertionId } = payload;
          const assertion = await StorageManager.getAssertion(assertionId);
          sendResponse({ success: true, assertion });
        } catch (err) {
          Logger.error('background', `GET_ASSERTION failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'UPDATE_ASSERTION': {
      (async () => {
        try {
          const { assertionId, patch } = payload;
          const updated = await StorageManager.updateAssertion(assertionId, patch);
          broadcastStorageChanged('assertion', assertionId, 'saved');
          sendResponse({ success: true, assertion: updated });
        } catch (err) {
          Logger.error('background', `UPDATE_ASSERTION failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'DELETE_ASSERTION': {
      (async () => {
        try {
          const { assertionId } = payload;
          const assertion = await StorageManager.getAssertion(assertionId);
          await deleteRecordWithSync('assertion', assertionId, () => StorageManager.deleteAssertion(assertionId), assertion?.groundId);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `DELETE_ASSERTION failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ── v2.72.29 (Pass 17) — Perspective CRUD ──────────────────────────────
    case 'SAVE_PERSPECTIVE': {
      (async () => {
        try {
          const { perspective } = payload;
          await StorageManager.savePerspective(perspective);
          await broadcastStorageChanged('perspective', perspective.id, 'saved');
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `SAVE_PERSPECTIVE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
    case 'LIST_PERSPECTIVES': {
      (async () => {
        try {
          const { groundId } = payload;
          const perspectives = await StorageManager.listPerspectives(groundId);
          sendResponse({ success: true, perspectives });
        } catch (err) {
          Logger.error('background', `LIST_PERSPECTIVES failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
    // v2.72.45 (Pass 17g iter) — GET_GROUND for the debugger's perspective-capture
    // header label. Mirrors GET_PERSPECTIVE.
    case 'GET_GROUND': {
      (async () => {
        try {
          const { id } = payload ?? {};
          const ground = await StorageManager.getGround(id);
          // v2.74.319 — Attach the Ground's perspectives + assertions to the
          // response. getGround() returns only the raw Ground record;
          // perspectives/assertions are stored separately per-Ground. Several
          // consumers (fragment-author's _loadGroundCatalog, which powers
          // the landmark dropdown + condition-type Perspectives/Custom
          // optgroups) read `res.ground.perspectives` / `.assertions` — without
          // this assembly those were always undefined, so the landmark
          // dropdown never populated. Mirrors GET_GROUND_LIBRARY's
          // per-Ground assembly. Additive: callers that ignore the arrays
          // are unaffected.
          if (ground) {
            try {
              const [perspectives, assertions] = await Promise.all([
                StorageManager.listPerspectives(id),
                StorageManager.listAssertions(id),
              ]);
              ground.perspectives    = Array.isArray(perspectives)    ? perspectives    : [];
              ground.assertions = Array.isArray(assertions) ? assertions : [];
            } catch (e) {
              Logger.warn('background', `GET_GROUND: perspective/assertion assembly failed: ${e.message}`);
              if (!Array.isArray(ground.perspectives))    ground.perspectives    = [];
              if (!Array.isArray(ground.assertions)) ground.assertions = [];
            }
          }
          sendResponse({ success: true, ground });
        } catch (err) {
          Logger.error('background', `GET_GROUND failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
    // v2.74.27 — Bulk fetch for the Ground sidepanel's read-only browse
    // view. Returns every Ground with its Fragment / Assertion / Perspective /
    // Observation / Analysis lists in one round trip. Strategies are
    // intentionally omitted — the Ground sidepanel doesn't surface them.
    case 'GET_GROUND_LIBRARY': {
      (async () => {
        try {
          const grounds = await StorageManager.getAllGrounds();
          const out = [];
          for (const g of grounds) {
            // v2.74.434 — Include the Ground siteMap (GROUND_SPEC § 7) so the
            // sidepanel header can show a 🗺 node badge + inline graph viewer.
            // (Replaces the retired GroundMap.)
            const [fragments, assertions, perspectives, observations, analyses, siteMap] =
              await Promise.all([
                StorageManager.listFragments(g.id),
                StorageManager.listAssertions(g.id),
                StorageManager.listPerspectives(g.id),
                StorageManager.listObservations(g.id),
                StorageManager.listAnalyses(g.id),
                _readSiteMap(g.id),
              ]);
            const siteMapStats = siteMap ? SiteMap.siteMapStats(siteMap) : null;
            out.push({ ground: g, fragments, assertions, perspectives, observations, analyses, siteMap, siteMapStats });
          }
          sendResponse({ success: true, grounds: out });
        } catch (err) {
          Logger.error('background', `GET_GROUND_LIBRARY failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
    case 'GET_PERSPECTIVE': {
      (async () => {
        try {
          const { perspectiveId } = payload;
          const perspective = await StorageManager.getPerspective(perspectiveId);
          sendResponse({ success: true, perspective });
        } catch (err) {
          Logger.error('background', `GET_PERSPECTIVE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
    case 'DELETE_PERSPECTIVE': {
      (async () => {
        try {
          const { perspectiveId } = payload;
          const perspective = await StorageManager.getPerspective(perspectiveId);
          await deleteRecordWithSync('perspective', perspectiveId, () => StorageManager.deletePerspective(perspectiveId), perspective?.groundId);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `DELETE_PERSPECTIVE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.35 — Background handler for analysis deletion. Previously
    // Studio's deleteAnalysis() helper called StorageManager directly;
    // the Ground sidepanel needs a message-routed equivalent so it can
    // ✕-delete entries the same way other sections do.
    case 'DELETE_ANALYSIS': {
      (async () => {
        try {
          const { analysisId } = payload;
          const analysis = await StorageManager.getAnalysis(analysisId);
          await deleteRecordWithSync('analysis', analysisId, () => StorageManager.deleteAnalysis(analysisId), analysis?.groundId);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `DELETE_ANALYSIS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ╔══════════════════════════════════════════════════════════════════════╗
    // ║ Pass C — STRATEGY AUTHORING                                          ║
    // ╚══════════════════════════════════════════════════════════════════════╝

    case 'SAVE_STRATEGY': {
      (async () => {
        try {
          const { strategy } = payload;
          if (!strategy?.id || !strategy?.groundId) {
            sendResponse({ success: false, error: 'Strategy requires { id, groundId }' });
            return;
          }
          await StorageManager.saveStrategy(strategy);
          broadcastStorageChanged('strategy', strategy.id, 'saved');
          // v2.27.0 — notify chat's capability registry so suggestion cards
          // refresh. Previously this was a latent bug: Strategy saves didn't
          // trigger a chat capability refresh, so invoking the changed
          // Strategy showed stale data.
          CapabilityAPI.notifyRegistryChange('updated', strategy.id);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `SAVE_STRATEGY failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'DELETE_STRATEGY': {
      (async () => {
        try {
          const { strategyId } = payload;
          const strategy = await StorageManager.getStrategy(strategyId);
          await deleteRecordWithSync('strategy', strategyId, () => StorageManager.deleteStrategy(strategyId), strategy?.groundId);
          CapabilityAPI.notifyRegistryChange('removed', strategyId);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `DELETE_STRATEGY failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // (the WORKFLOW domain — SAVE/DELETE/INVOKE/CANCEL/PAUSE/RESUME/STEP/STEP_OVER/BREAKPOINTSx3/
    // GET_WORKFLOW_BREAKPOINTS — lived here until v2.74.953; CR-X3c migrated it, with its state, to
    // background/handlers/workflowDebug.js.)

    // v2.27.0 — Ground CUD through background.js. Previously sidepanel.js
    // saved Grounds directly via StorageManager; Studio uses the same pattern.
    // Routing through background centralizes the STORAGE_CHANGED broadcast
    // and the CapabilityAPI registry notification. UI layers still broadcast
    // from their side too (belt-and-suspenders; the message is idempotent).
    case 'SAVE_GROUND': {
      (async () => {
        try {
          const { ground } = payload;
          if (!ground?.id) {
            sendResponse({ success: false, error: 'Ground requires { id }' });
            return;
          }
          await StorageManager.saveGround(ground);
          broadcastStorageChanged('ground', ground.id, 'saved');
          CapabilityAPI.notifyRegistryChange('updated', null);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `SAVE_GROUND failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'DELETE_GROUND': {
      (async () => {
        try {
          const { groundId } = payload;
          await syncBridgeOnStorageChange('ground', groundId, 'deleted');
          await StorageManager.deleteGround(groundId);
          const syncRes = await runSync();
          broadcastSyncApplied(syncRes.applied);
          broadcastStorageChanged('ground', groundId, 'deleted');
          CapabilityAPI.notifyRegistryChange('removed', null);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `DELETE_GROUND failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.329 — GROUND_SPEC § 5 derived intent. Synthesize a Ground's
    // description from its constituent Perspectives (lazy/manual: only on explicit
    // request). Cache-validated by inputs hash + prompt version; returns the
    // cached value untouched when nothing changed (unless force=true).
    case 'DERIVE_GROUND_DESCRIPTION': {
      (async () => {
        try {
          const { groundId, force = false } = payload ?? {};
          if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
          const ground = await StorageManager.getGround(groundId);
          if (!ground) { sendResponse({ success: false, error: `Ground ${groundId} not found` }); return; }
          const perspectives = await StorageManager.listPerspectives(groundId);
          if (!Array.isArray(perspectives) || perspectives.length === 0) {
            sendResponse({ success: false, error: 'Ground has no Perspectives to derive from' });
            return;
          }
          const hash = derivationInputsHash(perspectives);
          if (!force && ground.derivedDescription
              && ground.derivationInputsHash === hash
              && (ground.derivationVersion || 0) === DERIVATION_VERSION) {
            sendResponse({ success: true, cached: true, derivedDescription: ground.derivedDescription, derivedAt: ground.derivedAt });
            return;
          }
          const text = await AnthropicService.deriveGroundDescription({
            name      : ground.name,
            urlPrimary: ground.urlPatterns?.find(p => p?.isPrimary)?.pattern ?? ground.urlPatterns?.[0]?.pattern ?? ground.url,
            perspectives   : perspectives.map(l => ({ name: l.name, description: l.description })),
          });
          if (!text) {
            sendResponse({ success: false, error: 'Derivation returned nothing (LLM unavailable or empty response)' });
            return;
          }
          const derivedAt = Date.now();
          await StorageManager.updateGround(groundId, {
            derivedDescription   : text,
            derivedAt,
            derivationVersion    : DERIVATION_VERSION,
            derivationInputsHash : hash,
          });
          broadcastStorageChanged('ground', groundId, 'saved');
          sendResponse({ success: true, cached: false, derivedDescription: text, derivedAt });
        } catch (err) {
          Logger.error('background', `DERIVE_GROUND_DESCRIPTION failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.329 — Set or clear a Ground's description override (GROUND_SPEC
    // § 5). override null/empty → clear (fall back to derived).
    case 'SET_GROUND_DESCRIPTION_OVERRIDE': {
      (async () => {
        try {
          const { groundId, override } = payload ?? {};
          if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
          const value = (typeof override === 'string' && override.trim()) ? override.trim() : null;
          const updated = await StorageManager.updateGround(groundId, { descriptionOverride: value });
          if (!updated) { sendResponse({ success: false, error: `Ground ${groundId} not found` }); return; }
          broadcastStorageChanged('ground', groundId, 'saved');
          sendResponse({ success: true, descriptionOverride: value });
        } catch (err) {
          Logger.error('background', `SET_GROUND_DESCRIPTION_OVERRIDE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.330 — GROUND_SPEC § 9 lifecycle. Deprecate (soft-delete) /
    // reactivate. 'deprecated' is persisted; 'active' clears the flag so
    // getGround re-derives active/draft from Perspective presence. (Cascade-
    // deprecation to Perspectives/Workflows is deferred — those entities have no
    // lifecycle field yet; see SPEC_DEV.)
    case 'SET_GROUND_LIFECYCLE': {
      (async () => {
        try {
          const { groundId, lifecycle } = payload ?? {};
          if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
          if (lifecycle !== 'deprecated' && lifecycle !== 'active') {
            sendResponse({ success: false, error: `lifecycle must be 'deprecated' or 'active' (got ${lifecycle})` });
            return;
          }
          // 'active' clears the persisted flag (null) → effective state is
          // re-derived on read; 'deprecated' persists.
          const persisted = lifecycle === 'deprecated' ? 'deprecated' : null;
          const updated = await StorageManager.updateGround(groundId, { metadata: { lifecycle: persisted } });
          if (!updated) { sendResponse({ success: false, error: `Ground ${groundId} not found` }); return; }
          // v2.74.335 — GROUND_SPEC § 11 cascade: deprecating a Ground
          // deprecates its constituent Perspectives. Reactivation does NOT auto-
          // reactivate Perspectives (spec: opt-in, user reviews each).
          let cascaded = 0;
          if (lifecycle === 'deprecated') {
            try {
              const perspectives = await StorageManager.listPerspectives(groundId);
              for (const loc of perspectives) {
                if (loc?.lifecycle !== 'deprecated') {
                  await StorageManager.updatePerspective(loc.id, { lifecycle: 'deprecated' });
                  cascaded++;
                }
              }
            } catch (e) {
              Logger.warn('background', `SET_GROUND_LIFECYCLE perspective cascade failed: ${e.message}`);
            }
          }
          broadcastStorageChanged('ground', groundId, 'saved');
          sendResponse({ success: true, lifecycle: updated.metadata?.lifecycle, cascadedPerspectives: cascaded });
        } catch (err) {
          Logger.error('background', `SET_GROUND_LIFECYCLE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.335 — PERSPECTIVE_SPEC § 12 lifecycle. Deprecate (soft-delete) /
    // reactivate a single Perspective. 'deprecated' excludes it from the active
    // set + authoring; 'active' restores it.
    case 'SET_PERSPECTIVE_LIFECYCLE': {
      (async () => {
        try {
          const { perspectiveId, lifecycle } = payload ?? {};
          if (!perspectiveId) { sendResponse({ success: false, error: 'perspectiveId required' }); return; }
          if (lifecycle !== 'deprecated' && lifecycle !== 'active') {
            sendResponse({ success: false, error: `lifecycle must be 'deprecated' or 'active' (got ${lifecycle})` });
            return;
          }
          const updated = await StorageManager.updatePerspective(perspectiveId, { lifecycle });
          if (!updated) { sendResponse({ success: false, error: `Perspective ${perspectiveId} not found` }); return; }
          broadcastStorageChanged('perspective', perspectiveId, 'saved');
          sendResponse({ success: true, lifecycle: updated.lifecycle });
        } catch (err) {
          Logger.error('background', `SET_PERSPECTIVE_LIFECYCLE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.336 — PERSPECTIVE_SPEC § 3/§ 13: LLM proposes a structured composition
    // (LandmarkNode[] + groupings/sequences) over the perspective's already-picked
    // landmarks. The author reviews/keeps it. Stateless — takes the landmarks
    // in the payload (they live in the unsaved draft).
    case 'PROPOSE_PERSPECTIVE_STRUCTURE': {
      (async () => {
        try {
          // v2.74.347 — `priorStructure` (the reviewed structure + judgments)
          // turns this into a refine call; absent on a first proposal.
          const { name, description, landmarks, priorStructure } = payload ?? {};
          const structure = await AnthropicService.proposePerspectiveStructure({ name, description, landmarks, priorStructure });
          if (!structure) {
            sendResponse({ success: false, error: 'No structure returned (LLM unavailable, or no landmarks with UIDs to structure)' });
            return;
          }
          sendResponse({ success: true, structure });
        } catch (err) {
          Logger.error('background', `PROPOSE_PERSPECTIVE_STRUCTURE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'EXTRACT_STRATEGY_PARAMS': {
      (async () => {
        try {
          // v2.74.114 — Validate up front so a missing payload doesn't
          // produce an opaque destructure-failure error.
          const { capabilityId, question } = payload ?? {};
          if (!capabilityId) {
            sendResponse({ success: false, error: 'capabilityId required' });
            return;
          }
          if (typeof question !== 'string') {
            sendResponse({ success: false, error: 'question required' });
            return;
          }
          const strategy = await StorageManager.getStrategy(capabilityId);
          if (!strategy) {
            sendResponse({ success: false, error: 'Strategy not found' });
            return;
          }
          // v2.74.890 — Coerce to string param names. Legacy capabilities
          // store strategy.params as object descriptors ({ name, kind, type,
          // ... }) rather than bare strings; passing those objects straight
          // through made extractStrategyParams key parsed[<object>] (→ every
          // param fell into `missing` AS AN OBJECT), which later crashed
          // ParamForm.renderField. Normalize at the boundary.
          const paramNames = (Array.isArray(strategy.params) ? strategy.params : [])
            .map(p => (typeof p === 'string' ? p : p && p.name))
            .filter(Boolean);
          const result = await AnthropicService.extractStrategyParams({
            question,
            strategyName : strategy.name ?? '',
            strategyGoal : strategy.goal ?? '',
            paramNames,
          });
          sendResponse({ success: true, params: result.params, missing: result.missing });
        } catch (err) {
          Logger.error('background', `EXTRACT_STRATEGY_PARAMS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.25.3 — Probe a set of conditions against the current active tab.
    // Used by the Fragment edit panel's "Test on current tab" button so the
    // user can see which of their postconditions currently hold.
    case 'PROBE_CONDITIONS': {
      (async () => {
        try {
          const conditions = Array.isArray(payload?.conditions) ? payload.conditions : [];
          if (conditions.length === 0) {
            sendResponse({ success: true, results: [] });
            return;
          }
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) {
            sendResponse({ success: false, error: 'No active tab' });
            return;
          }
          // Probe each condition individually so we can report per-condition result
          const results = [];
          for (const cond of conditions) {
            const probe = await new Promise(r => {
              chrome.tabs.sendMessage(tab.id, { type: 'CHECK_CONDITION', payload: { condition: cond } }, (res) => {
                if (chrome.runtime.lastError) {
                  r({ matched: false, error: chrome.runtime.lastError.message });
                } else {
                  r(res ?? { matched: false, error: 'no response from content script' });
                }
              });
            });
            results.push({
              condition: cond,
              matched: probe?.matched === true,
              reason: probe?.matched === true ? null : (probe?.error ?? 'condition not met'),
            });
          }
          sendResponse({ success: true, results });
        } catch (err) {
          Logger.error('background', `PROBE_CONDITIONS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'CAPABILITY_INVOKE': {
      (async () => {
        try {
          // v2.74.114 — Validate capabilityId up front.
          const { capabilityId, input, invocationId, debug, conversationId } = payload ?? {};
          if (!capabilityId) {
            sendResponse({ success: false, error: 'capabilityId required' });
            return;
          }
          // v2.38.0 (Pass K1) — pass debug option through to CapabilityAPI.
          // v2.71.4 — pass conversationId so terminal events can route back
          // to ConversationStore even when chat panel is closed.
          const result = await CapabilityAPI.invoke(capabilityId, input ?? {}, { invocationId, debug, conversationId });
          sendResponse({ success: true, ...result });
        } catch (err) {
          Logger.error('background', `CAPABILITY_INVOKE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'CAPABILITY_CANCEL': {
      (async () => {
        try {
          // v2.74.114 — Validate + log on failure for consistency with the
          // rest of the file's catch blocks.
          const { invocationId } = payload ?? {};
          if (!invocationId) {
            sendResponse({ success: false, error: 'invocationId required' });
            return;
          }
          const cancelled = await CapabilityAPI.cancel(invocationId);
          sendResponse({ success: true, cancelled });
        } catch (err) {
          Logger.error('background', `CAPABILITY_CANCEL failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.72.51 (Stage 2) — OPEN_DEBUGGER_PANEL now opens the unified
    // sidepanel.html and sets strategy-debug mode. Kept under the old
    // message name for callers that haven't migrated yet (e.g.,
    // chat.js's "open debugger" link).
    case 'OPEN_DEBUGGER_PANEL': {
      (async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = payload?.tabId ?? tab?.id;
          if (tabId == null) { sendResponse({ success: false, error: 'no tab' }); return; }
          await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
          await chrome.sidePanel.open({ tabId });
          __setSidepanelMode('strategy-debug', null);
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'OPEN_CHAT_PANEL': {
      (async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = payload?.tabId ?? tab?.id;
          if (tabId == null) { sendResponse({ success: false, error: 'no tab' }); return; }
          // v2.74.966 (gl 094214) — chat is WINDOW-SCOPED: bind via the GLOBAL default + open by
          // windowId, creating NO per-tab registration. The old per-tab pin made the chat document
          // SWAP on every tab hop (per-tab vs default binding resolve as different panel instances,
          // even for the same path — popup.js's Ground entry documented this at v2.74.30), which
          // stranded the walk's conversation on the origin tab when .965's establish flow opened the
          // teach site. Only a STALE capture/debug pin on this tab is displaced — and only when one
          // exists, since an unconditional per-tab set would re-introduce the pin this fix removes.
          await chrome.sidePanel.setOptions({ path: 'chat.html', enabled: true });
          try {
            const cur = await chrome.sidePanel.getOptions({ tabId });
            if (cur?.path && cur.path !== 'chat.html') await chrome.sidePanel.setOptions({ tabId, path: 'chat.html', enabled: true });
          } catch { /* getOptions unavailable — the global default wins */ }
          let windowId = (tab && tab.id === tabId) ? (tab.windowId ?? null) : null;
          if (windowId == null) { try { windowId = (await chrome.tabs.get(tabId))?.windowId ?? null; } catch { /* */ } }
          if (windowId != null) await chrome.sidePanel.open({ windowId });
          else await chrome.sidePanel.open({ tabId });
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.39.3 — On debugger boot, look up any currently-running debug
    // invocation so the panel can attach to it even if it missed the
    // INVOCATION_STARTED broadcast (race when studio ▶ opens the panel
    // and fires the invocation in quick succession).
    case 'GET_ACTIVE_DEBUG_INVOCATION': {
      (async () => {
        try {
          const list = await CapabilityAPI.listInvocations();
          // Find a running or queued debug-mode invocation, most recent first
          const candidates = (list ?? [])
            .filter(r => r.debugMode && r.debugMode !== 'off')
            .filter(r => r.status === 'running' || r.status === 'queued')
            .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
          const top = candidates[0];
          if (!top) { sendResponse({ success: true, invocation: null }); return; }
          sendResponse({
            success: true,
            invocation: {
              invocationId   : top.invocationId,
              capabilityId   : top.capabilityId,
              capabilityName : top.capabilityName,
              debugMode      : top.debugMode,
              totalSteps     : top.progress?.total ?? 0,
            },
          });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.72.45 (Pass 17g iter) — Perspective capture session, simplified.
    //
    // The session model changed: studio no longer hands off a metadata
    // draft. The user clicks "+ Perspective" on a Ground card; studio sends
    // BEGIN_PERSPECTIVE_CAPTURE with just the groundId. Background:
    //   1. Refuses if any debug invocation is active OR a session is pending
    //   2. Looks up the Ground, opens its URL as the starting tab (or
    //      focuses an existing tab matching it) — user navigates from there
    //   3. Stores the session {groundId, tabId, sessionId, startedAt}
    //   4. Re-injects the content script so PING/START_PICK reach the
    //      tab without a manual reload
    //   5. Broadcasts PERSPECTIVE_CAPTURE_BEGIN_BROADCAST so the debugger
    //      sidepanel (already opened by studio in its gesture-fresh
    //      click handler) enters capture mode
    //
    // The debugger then handles authoring: name + description + URL pattern
    // (auto-synced to the active tab) + landmarks + save. After save the
    // debugger STAYS in capture mode (only name/description/landmarks
    // clear), letting the user author multiple perspectives for the same Ground
    // without leaving the sidepanel.
    // v2.72.50 (Stage 1) — Sidepanel mode registry handlers.
    //
    // The sidepanel shell asks on cold boot what mode to mount, and any
    // caller (studio, in-mode UI, etc.) can request a mode change here.
    // Background owns the registry; switching modes broadcasts
    // SIDEPANEL_MODE_CHANGED which the shell listens for.
    case 'GET_SIDEPANEL_MODE': {
      sendResponse({
        success: true,
        mode: __sidepanelMode,
        payload: __sidepanelModePayload,
      });
      return false;
    }
    case 'REQUEST_SIDEPANEL_MODE': {
      const { mode, payload: modePayload } = payload ?? {};
      // Allow null/undefined to mean "go idle".
      __setSidepanelMode(mode ?? null, modePayload ?? null);
      sendResponse({ success: true });
      return false;
    }
    // v2.74.36 — Shell queries this on tab activation in its window to
    // figure out what mode (if any) was previously associated with the
    // newly-active tab. Returns null when no record exists; the shell
    // falls back to ground-view for that tab.
    // v2.74.392 — AUTO_DISCOVER_PERSPECTIVE removed (legacy Claude auto-suggested
    // landmarks). Perspective authoring is the description-first propose→resolve→
    // auto-structure flow; "+ Perspective" opens a blank draft.

    // v2.74.348 — PERSPECTIVE_SPEC § 13 description-first proposal flow. Given the
    // user's intent (the Perspective description) + the current page, Claude
    // proposes 2-3 perspective options (named roles to fill + URL predicates).
    // Mirrors AUTO_DISCOVER_PERSPECTIVE's content-script inject + DOM_SNAPSHOT_RICH,
    // but is intent-seeded and role-scaffolded, and is NOT cached (the
    // proposal depends on the free-text intent, not just the URL).
    case 'PROPOSE_PERSPECTIVES': {
      (async () => {
        try {
          // v2.74.350/366 — Enhanced context is now canonical (baseline arm
          // removed). Always gather a screenshot + the Ground's existing
          // perspectives/landmarks and pass them to proposePerspectives.
          const { tabId, intent, groundId = null, targetGoalId = null, intentSpecHint = null } = payload ?? {};
          if (typeof tabId !== 'number') {
            sendResponse({ success: false, error: 'tabId required' });
            return;
          }
          if (typeof intent !== 'string' || !intent.trim()) {
            sendResponse({ success: false, error: 'Write an intent description first — it is the proposal seed.' });
            return;
          }
          let tabInfo;
          try {
            tabInfo = await chrome.tabs.get(tabId);
          } catch (e) {
            sendResponse({ success: false, error: `Tab not found: ${e.message}` });
            return;
          }
          const url = tabInfo?.url ?? '';
          if (!/^https?:/i.test(url)) {
            sendResponse({ success: false, error: 'This page does not allow content scripts (chrome://, extension page, or restricted URL). Open a regular https:// page first.' });
            return;
          }
          try {
            await chrome.scripting.executeScript({
              target: { tabId, allFrames: true },
              files: ['ContentScripts/contentScript.js'],
            });
          } catch (e) {
            Logger.warn('background', `PROPOSE_PERSPECTIVES: content-script inject failed (continuing): ${e.message}`);
          }
          let snap;
          try {
            snap = await chrome.tabs.sendMessage(tabId, { type: 'DOM_SNAPSHOT_RICH' }, { frameId: 0 });   // top frame only
          } catch (e) {
            sendResponse({ success: false, error: `DOM snapshot failed: ${e.message}` });
            return;
          }
          if (!snap?.success) {
            sendResponse({ success: false, error: snap?.error ?? 'DOM snapshot returned no payload' });
            return;
          }

          // PB-10 — deterministic form oracle: enumerate the page's required-field markers (top frame)
          // so the intent-driven directive can NAME every field a completion intent must cover. Best-
          // effort; if it fails the directive degrades to shape-only (still "one perspective, all fields").
          let formFields = null;
          try {
            const ff = await chrome.tabs.sendMessage(tabId, { type: 'ENUMERATE_FORM_FIELDS' }, { frameId: 0 });
            if (ff?.success && Array.isArray(ff.fields)) formFields = ff.fields;
          } catch (e) {
            Logger.warn('background', `PROPOSE_PERSPECTIVES: form enumeration failed (continuing): ${e.message}`);
          }

          // ── Enhanced context (best-effort; any failure degrades, not aborts) ──
          let screenshot = null, siblingPerspectives = null, registryLandmarks = null;
          // Screenshot the visible tab. Only meaningful when the target tab
          // is the active one in its window (captureVisibleTab grabs whatever
          // is visible); skip otherwise so we never attach the wrong page.
          if (tabInfo.active) {
            try {
              screenshot = await chrome.tabs.captureVisibleTab(tabInfo.windowId, { format: 'jpeg', quality: 55 });
            } catch (e) {
              Logger.warn('background', `PROPOSE_PERSPECTIVES: screenshot failed (continuing): ${e.message}`);
            }
          } else {
            Logger.info('background', 'PROPOSE_PERSPECTIVES: target tab not active — skipping screenshot');
          }
          if (groundId) {
            try {
              const perspectives = await StorageManager.listPerspectives(groundId);
              const rolesOf = (loc) => {
                const set = new Set();
                const walk = (nodes) => { for (const n of Array.isArray(nodes) ? nodes : []) { if (n?.role) set.add(n.role); if (Array.isArray(n?.contains)) walk(n.contains); if (Array.isArray(n?.alternatives)) walk(n.alternatives); } };
                walk(Array.isArray(loc?.landmarks) ? loc.landmarks : []);
                return [...set];
              };
              siblingPerspectives = (perspectives ?? []).map(l => ({ name: l.name, description: l.description, roles: rolesOf(l) }));
            } catch (e) {
              Logger.warn('background', `PROPOSE_PERSPECTIVES: listPerspectives failed (continuing): ${e.message}`);
            }
            try {
              const lms = await StorageManager.listLandmarksForGround(groundId);
              registryLandmarks = (lms ?? []).map(lm => ({ alias: lm.alias, a11yRole: lm.a11yRole, description: lm.description }));
            } catch (e) {
              Logger.warn('background', `PROPOSE_PERSPECTIVES: listLandmarksForGround failed (continuing): ${e.message}`);
            }
          }

          // v2.74.426 — #2 P2: depth now rides on the Locale (its layers), so propose
          // reads ONE artifact. The poke→reveal sweep is folded into the Locale during
          // Explore; the separate pageStructure read is gone.
          let localeForPropose = null;
          if (groundId) {
            try {
              const pm = await _readLocaleCache(groundId, _normalizeUrlForPerspectiveCache(snap.url ?? url));
              if (pm?.model && (Date.now() - (pm.capturedAt ?? 0)) < LOCALE_TTL_MS) localeForPropose = pm.model;
            } catch (e) {
              Logger.warn('background', `PROPOSE_PERSPECTIVES: locale read failed (continuing): ${e.message}`);
            }
          }

          const proposal = await AnthropicService.proposePerspectives({
            intent,
            url        : snap.url   ?? url,
            title      : snap.title ?? '',
            domSnapshot: snap.snapshot ?? '',
            screenshot,
            siblingPerspectives,
            registryLandmarks,
            locale  : localeForPropose,
            targetGoalId,           // PB-1: goal-anchor the feature reference (optional through-line)
            formFields,             // PB-10: required-field markers → must-cover list in the directive
            intentSpecHint,         // PB-10: LLM-emitted {shape, completeness} from groundIntent (primary extractor)
          });
          if (!proposal || !Array.isArray(proposal.options) || proposal.options.length === 0) {
            sendResponse({ success: false, error: 'Claude returned no usable perspectives — try a more specific intent.' });
            return;
          }
          // PB-1 (R3) — emit the first authoring-stage outcome: how many proposed roles got grounded
          // to a real page feature (featureId set). This is the front-of-pipeline fidelity signal.
          if (groundId) {
            try {
              let roleCount = 0, groundedCount = 0;
              for (const o of proposal.options) for (const r of (o.roles || [])) { roleCount++; if (r.featureId) groundedCount++; }
              await _appendOutcomes(groundId, [Outcomes.makeStageEvent('propose', {
                groundId,
                input: { roleOrIntent: intent.slice(0, 120) },
                detail: { optionCount: proposal.options.length, roleCount, groundedCount, targetGoalId: targetGoalId || null },
              })]);
            } catch (e) { Logger.warn('background', `PROPOSE_PERSPECTIVES outcome emit: ${e.message}`); }
          }
          // meta lets the UI label exactly what context this run used. Depth = the
          // Locale's non-surface layers (revealed content).
          const revealingControls = localeForPropose
            ? Object.values(localeForPropose.layers || {}).filter(l => l && l.kind !== 'surface').length : 0;
          const meta = {
            screenshot: !!screenshot,
            siblingPerspectives: Array.isArray(siblingPerspectives) ? siblingPerspectives.length : 0,
            registryLandmarks: Array.isArray(registryLandmarks) ? registryLandmarks.length : 0,
            pageStructure: revealingControls > 0,
            revealingControls,
            locale: !!localeForPropose,
            localeFeatures: localeForPropose ? Object.keys(localeForPropose.features || {}).length : 0,
          };
          sendResponse({ success: true, options: proposal.options, meta });
        } catch (err) {
          Logger.error('background', `PROPOSE_PERSPECTIVES failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.378 — pageStructure BANDED WALK. The background drives a viewport-
    // band loop bottom-to-top: metrics (scroll to bottom, measure) → for each
    // band { content-script enumerates VISIBLE candidates → background
    // screenshots THIS band → LLM planner picks which to poke (piecemeal, with a
    // screenshot that matches what's in view) → content-script pokes only those,
    // verifying each } → cleanup. Per-band planning replaces the brittle one-shot
    // plan, and the planner only poking what it CHOSE is what keeps the sweep
    // from navigating. The artifact is assembled here from the per-band results.
    // Payload: { tabId, groundId?, bandBudget? } → { success, structure, cacheKey }.
    // (EXPLORE_PAGE_STRUCTURE lived here until v2.74.951 — CR-X3a migrated the explore domain, with
    // its in-flight set, to background/handlers/explore.js.)

    // v2.74.446 — Cross-locale label harvest (language-agnostic resolution, slice 3b).
    // For a just-modeled archetype with multiple locales, enumerate its OTHER-language
    // exemplars (read-only ENUMERATE_PAGE), align features across locales by their
    // language-invariant key (SiteMap.alignFeaturesAcrossLocales), and attach the
    // {locale:label} alias set onto the cached Locale's features. No LLM (enumerate is
    // deterministic, alignment is pure). Driven by the studio Explore queue's background tab.
    case 'HARVEST_LOCALE_LABELS': {
      (async () => {
        try {
          const { tabId, groundId, exemplarUrl, exemplarByLocale = {} } = payload ?? {};
          if (typeof tabId !== 'number' || !groundId || !exemplarUrl) { sendResponse({ success: false, error: 'tabId, groundId, exemplarUrl required' }); return; }
          const localeKey = _normalizeUrlForPerspectiveCache(exemplarUrl);
          const cached = await _readLocaleCache(groundId, localeKey);
          const model = cached?.model;
          if (!model?.features || !Object.keys(model.features).length) { sendResponse({ success: false, error: 'no cached Locale to enrich' }); return; }
          const rules = (await _readSiteMap(groundId))?.templateRules || [];
          const primaryLocale = SiteMap.localeFromUrl(exemplarUrl, rules) || 'primary';
          const byLocale = { [primaryLocale]: Object.values(model.features) };

          const others = Object.entries(exemplarByLocale)
            .filter(([loc, url]) => loc !== primaryLocale && url && url !== exemplarUrl)
            .slice(0, MAX_HARVEST_OTHER_LOCALES);
          for (const [loc, url] of others) {
            try {
              await _navigateBgTab(tabId, url);
              await new Promise(r => setTimeout(r, 1200));
              try { await chrome.scripting.executeScript({ target: { tabId }, files: ['ContentScripts/contentScript.js'] }); } catch { /* */ }
              const enr = await chrome.tabs.sendMessage(tabId, { type: 'ENUMERATE_PAGE' }, { frameId: 0 });
              if (enr?.success && Array.isArray(enr.features)) byLocale[loc] = enr.features;
            } catch (e) { Logger.warn('explore', `label harvest ${loc} failed (continuing): ${e.message}`); }
          }

          const aligned = SiteMap.alignFeaturesAcrossLocales(byLocale, { rules });
          let enriched = 0;
          for (const af of aligned) {
            const mf = model.features[af.id];   // base feature is from the primary locale → same id
            if (mf && af.labelsByLocale && Object.keys(af.labelsByLocale).length > 1) { mf.labelsByLocale = af.labelsByLocale; enriched++; }
          }
          if (enriched) {
            await _writeLocaleCache(groundId, localeKey, { ...cached, model });
            await syncGroundAssetsAfterSave(groundId, { localeKey });
          }
          Logger.info('explore', `locale label harvest: ${Object.keys(byLocale).length} language(s), ${enriched} feature(s) enriched for ${localeKey}`);
          sendResponse({ success: true, enriched, languages: Object.keys(byLocale) });
        } catch (err) {
          Logger.error('background', `HARVEST_LOCALE_LABELS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.393 — Ground a user's raw intent in the page. Reads the Locale's L2
    // goals (preferred) + its affordance description and asks Claude for a refined,
    // page-grounded intent + achievability verdict (preserving the user's goal).
    // Payload: { tabId, groundId?, intent } → { success, groundedIntent,
    //   achievable, note, hadAffordance } | { success:false, error }.
    case 'GROUND_INTENT': {
      (async () => {
        try {
          const { tabId, groundId = null, intent } = payload ?? {};
          if (typeof intent !== 'string' || !intent.trim()) { sendResponse({ success: false, error: 'intent required' }); return; }
          // SG-1 (Comprehend, SHADOW) — page-INDEPENDENT intent spec, kicked off in parallel with the
          // page-dependent assessor below. Runs regardless of Explore; the comprehension object is logged
          // inside comprehendIntent. Surfaced on the response but NOT yet consumed (SG-2 Select will).
          const intentSpecP = AnthropicService.comprehendIntent({ userIntent: intent })
            .catch((e) => { Logger.warn('background', `comprehendIntent failed (continuing): ${e.message}`); return null; });
          let url = '', title = '';
          if (typeof tabId === 'number') { try { const t = await chrome.tabs.get(tabId); url = t?.url ?? ''; title = t?.title ?? ''; } catch { /* */ } }
          // v2.74.409 — Prefer the Locale's STRUCTURED goals (L2) to anchor the
          // grounding; fall back to the free-text affordance description. Both come
          // from Explore.
          let affordances = null;
          let goals = null;
          let localeModel = null;   // SG-2c — the full Locale (features) for the Select shadow pass
          if (groundId && url) {
            const key = _normalizeUrlForPerspectiveCache(url);
            try {
              const pm = await _readLocaleCache(groundId, key);
              localeModel = pm?.model ?? null;
              affordances = pm?.model?.affordances ?? null;   // v2.74.426 — #2 P1: from the Locale now
              const gs = pm?.model?.goals ? Object.values(pm.model.goals) : [];
              if (gs.length && (Date.now() - (pm.capturedAt ?? 0)) < LOCALE_TTL_MS) {
                goals = gs.map(g => ({ label: g.label, description: g.description }));
              }
            } catch { /* */ }
          }
          // SG-2c (Select, SHADOW) — Comprehend → matchSubGoals over the Locale, for ANY shape with a
          // captured Locale. v2.74.596 — was gated to `complete` only (shadow-mode caution), which
          // suppressed the plan + run button for the COMMON `act`/`read` "search" intents. The atom is
          // shape-general (matchSubGoals/Cover/Bind all handle non-complete), so run it for all shapes.
          // Resolves null when there's no Locale. The reconciled selection is logged + surfaced.
          const selectionP = intentSpecP.then(async (spec) => {
            if (!spec || !localeModel || !localeModel.features) return null;
            try { return await AnthropicService.matchSubGoals({ spec, locale: localeModel }); }
            catch (e) { Logger.warn('background', `matchSubGoals failed (continuing): ${e.message}`); return null; }
          });
          const _projF = (f) => f ? { id: f.id, label: f.label || '', selector: f.selector || null } : null;
          const _projSelection = (sel) => sel ? {
            matches: sel.matches,
            reconciledSubGoals: (sel.reconciledSubGoals || []).map((s) => ({ id: s.id, label: s.label, effectiveScope: s.effectiveScope, scopeChanged: s.scopeChanged, features: s.features })),
            orphanRequired: (sel.orphanRequired || []).map(_projF),
            boundary: { requiredFields: (sel.boundary?.requiredFields || []).map(_projF), successAction: _projF(sel.boundary?.successAction) },
          } : null;
          // SG-4b (SHADOW) — run the full spine to a synthesized PLAN: Cover (completeness verdict) → Bind
          // (selection → roles) → synth (fill ops, file deferred) → safety class (irreversible commits
          // deferred). NON-executing — surfaced + logged so the whole Comprehend→Select→Cover→Bind plan is
          // observable on a ground. Actually running it is a separate, opt-in step.
          const planP = Promise.all([intentSpecP, selectionP]).then(([spec, selection]) => {
            if (!spec || !selection || !localeModel) return null;
            // v2.74.641 (C3) — cache the GOOD propose-time spec+selection so RUN_SG_TRIAL reuses it on the
            // same page instead of re-comprehending (which re-rolls shape + re-matches, breaking filters).
            _cacheSgSpec(groundId, url, intent, spec, selection);
            try {
              const cover = coverComplete(spec, selection);
              const roles = selectionToTrialRoles(spec, selection, localeModel);
              const draft0 = synthesizeTrialOp({ groundedIntent: intent, roles, locale: localeModel });
              const safety = classifyTrialSafety(intent, draft0);
              const acts = Array.isArray(safety.actions) ? safety.actions : [];
              Logger.info('background', `SG plan (${spec.shape}): cover=${cover.complete} (req ${cover.completionCount ?? '-'}, orphans ${(cover.orphanRequired || []).length}) runnable=${draft0.runnable} steps=${acts.length} deferred=${safety.deferred.length} skipped=${draft0.skipped.length} safety=${safety.safetyClass}`);
              return {
                cover, runnable: draft0.runnable, safetyClass: safety.safetyClass,
                deferred: safety.deferred, skipped: draft0.skipped,
                steps: acts.slice(0, 40).map((a) => ({ action: a.action, selector: a.selector ? String(a.selector).slice(0, 60) : undefined, value: a.value })),
              };
            } catch (e) { Logger.warn('background', `SG plan failed (continuing): ${e.message}`); return null; }
          });
          if (!affordances && !goals) {
            // Nothing explored → can't ground; pass the intent through so the UI
            // can still propose (and nudge the user to Explore first). Comprehend is
            // page-independent, so its spec is still attached.
            sendResponse({ success: true, achievable: 'unknown', shape: null, completeness: null, note: 'Run Explore on this page to assess the intent against its actual capabilities.', hadAffordance: false, intentSpec: await intentSpecP, selection: _projSelection(await selectionP), plan: await planP });
            return;
          }
          const out = await AnthropicService.groundIntent({ userIntent: intent, affordances, goals, url, title });
          if (!out) { sendResponse({ success: false, error: 'Claude returned no grounded intent.' }); return; }
          const plan = await planP;
          // Reconcile the verdict with the catalog-grounded plan. groundIntent sees only the affordance prose
          // + goal LABELS (lossy: a real feature not bucketed into a goal is invisible to it — e.g. Pixabay's
          // "Radio" link exists but was assigned to no goal, so the verdict falsely said "not supported"),
          // while the plan spine matched the FULL Locale catalog. If the spine found a RUNNABLE path, the page
          // demonstrably serves the intent — so a "no"/"unknown" verdict is a false negative. Upgrade it so the
          // verdict and the Run button can't contradict on screen (the live regressions).
          const verdict = { ...out };
          if (plan && plan.runnable && (out.achievable === 'no' || out.achievable === 'unknown' || !out.achievable)) {
            verdict.achievable = 'partial';
            verdict.reconciledByPlan = true;
            verdict.note = `A runnable path was found on this page (${(plan.steps || []).length} step(s)) — verify it matches your intent.${out.note ? ` (Prior assessment: ${out.note})` : ''}`;
          }
          sendResponse({ success: true, ...verdict, hadAffordance: true, hadGoals: !!goals, intentSpec: await intentSpecP, selection: _projSelection(await selectionP), plan });
        } catch (err) {
          Logger.error('background', `GROUND_INTENT failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.468 — Match a free-text intent against the site capability catalog. The lexical
    // ranker (SiteMap.matchSiteCapabilities) is the instant baseline + fallback; when Claude is
    // reachable an LLM re-rank (semantic / synonym) replaces it. Payload: { groundId, intent } →
    // { success, matches:[{goal,count,pageTypes,archetypes,why?}], source:'llm'|'lexical'|'none' }.
    case 'MATCH_CAPABILITIES': {
      (async () => {
        try {
          const { groundId = null, intent } = payload ?? {};
          if (typeof intent !== 'string' || !intent.trim()) { sendResponse({ success: false, error: 'intent required' }); return; }
          const sm = groundId ? await _readSiteMap(groundId) : null;
          const catalog = SiteMap.siteMapCapabilities(sm);
          if (!catalog.capabilities.length) { sendResponse({ success: true, matches: [], source: 'none' }); return; }
          let matches = SiteMap.matchSiteCapabilities(intent, catalog, { limit: 12 });
          let source = 'lexical';
          // LLM re-rank over a bounded, numbered pool; only override lexical when it returns
          // something usable (else lexical stands — never worse than the instant baseline).
          const pool = catalog.capabilities.slice(0, 60);
          try {
            const ranking = await AnthropicService.matchCapabilitiesLLM({ intent, goals: pool.map(c => ({ label: c.goal, pageTypes: c.pageTypes })) });
            if (Array.isArray(ranking) && ranking.length) {
              const ranked = SiteMap.applyCapabilityRanking(pool, ranking).slice(0, 12);
              if (ranked.length) { matches = ranked; source = 'llm'; }
            }
          } catch (e) { Logger.warn('background', `MATCH_CAPABILITIES llm re-rank skipped: ${e.message}`); }
          sendResponse({ success: true, matches, source });
        } catch (err) {
          Logger.error('background', `MATCH_CAPABILITIES failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.471 — Synthesize a runnable capability (Fragment + Strategy) from a MODELED goal
    // (invocation arc, slice 2/3). Resolve the archetype's Locale → find the goal → draft an
    // action procedure (Core/capabilitySynth) → persist a Fragment + Strategy → return the
    // capabilityId. The result is a DRAFT for review (selectors/values/order may need
    // refinement); it's `runnable` (Strategy status 'ready') iff it has ≥1 real action.
    // Payload: { groundId, archetypeId, goal } → { success, capabilityId, name, runnable, warnings, actionCount }.
    case 'SYNTHESIZE_CAPABILITY': {
      (async () => {
        try {
          const { groundId = null, archetypeId = null, goal: goalLabel = null } = payload ?? {};
          if (!groundId || !archetypeId || !goalLabel) { sendResponse({ success: false, error: 'groundId, archetypeId, goal required' }); return; }
          const sm = await _readSiteMap(groundId);
          const node = sm?.nodes?.[archetypeId];
          if (!node) { sendResponse({ success: false, error: 'archetype not found in siteMap' }); return; }
          if (!node.localeId) { sendResponse({ success: false, error: 'archetype not modeled yet (no Locale) — Explore it first' }); return; }
          const pm = await _readLocaleCache(groundId, node.localeId);
          const model = pm?.model;
          // v2.74.473 — match on the NORMALIZED label: the catalog dedups goals across archetypes
          // and keeps one representative's original-cased label, which may differ from THIS
          // archetype's variant — an exact compare would spuriously miss.
          const wantKey = SiteMap.normalizeGoalLabel(goalLabel);
          const goal = model?.goals ? Object.values(model.goals).find((g) => g && SiteMap.normalizeGoalLabel(g.label) === wantKey) : null;
          if (!goal) { sendResponse({ success: false, error: `goal "${goalLabel}" not found in the archetype's Locale` }); return; }
          const url = node.exemplarUrl || (Array.isArray(node.instances) ? node.instances[0] : null) || null;
          const draft = CapabilitySynth.synthesizeCapabilityDraft(goal, model, { groundId, url });
          const records = CapabilitySynth.buildCapabilityRecords(draft, { groundId, fragmentId: crypto.randomUUID(), strategyId: crypto.randomUUID() });
          if (!records) { sendResponse({ success: false, error: 'could not build capability records' }); return; }
          await StorageManager.saveFragment(records.fragment);
          await StorageManager.saveStrategy(records.strategy);
          Logger.info('background', `synthesized capability ${records.strategy.id} from goal "${goalLabel.slice(0, 50)}" — ${draft.actions.length} action(s), runnable=${draft.runnable}${draft.warnings.length ? ` (${draft.warnings.length} warning(s))` : ''}`);
          sendResponse({ success: true, capabilityId: records.strategy.id, name: draft.name, runnable: draft.runnable, warnings: draft.warnings, actionCount: draft.actions.length });
        } catch (err) {
          Logger.error('background', `SYNTHESIZE_CAPABILITY failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.493 — Cross-Locale Workflows (GROUND_SPEC partOf): candidate multi-page journeys
    // to a target archetype, as workflow skeletons (workflowsTo). Read-only — feeds the studio
    // picker + lets the user choose a path before BUILD_WORKFLOW.
    case 'GET_WORKFLOWS': {
      (async () => {
        try {
          const { groundId = null, target = null, from = null, maxPaths = 8, maxDepth = 6 } = payload ?? {};
          if (!groundId || !target) { sendResponse({ success: false, error: 'groundId, target required' }); return; }
          const sm = await _readSiteMap(groundId);
          if (!sm?.nodes?.[target]) { sendResponse({ success: false, error: 'target archetype not in siteMap' }); return; }
          const skeletons = Workflows.workflowsTo(sm, target, { from, maxPaths, maxDepth });
          sendResponse({ success: true, target, count: skeletons.length, workflows: skeletons });
        } catch (err) {
          Logger.error('background', `GET_WORKFLOWS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.493 — Build a RUNNABLE cross-Locale workflow: resolve the path's per-step Locales,
    // stitch nav + per-step goals (buildWorkflowDraft), and persist as a Fragment + Strategy the
    // execution engine runs (buildCapabilityRecords). `path` (archetype ids) overrides the
    // shortest auto-path to `target`; `goals` maps archetypeId → goal label (omitted steps are
    // pass-through navigation). Best-effort DRAFT — review before running.
    case 'BUILD_WORKFLOW': {
      (async () => {
        try {
          const { groundId = null, target = null, from = null, path = null, goals = {}, name = null } = payload ?? {};
          if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
          const sm = await _readSiteMap(groundId);
          if (!sm?.nodes) { sendResponse({ success: false, error: 'no siteMap for this ground' }); return; }
          // Resolve the skeleton: explicit path, else shortest path to target.
          let skeleton = null;
          if (Array.isArray(path) && path.length) {
            if (!path.every((id) => sm.nodes[id])) { sendResponse({ success: false, error: 'path contains an unknown archetype' }); return; }
            skeleton = Workflows.workflowFromPath(sm, path);
          } else if (target) {
            const found = Workflows.pathsTo(sm, target, { from });
            if (!found.length) { sendResponse({ success: false, error: `no path to "${target}" in the siteMap` }); return; }
            skeleton = Workflows.workflowFromPath(sm, found[0]);
          } else {
            sendResponse({ success: false, error: 'target or path required' }); return;
          }
          // Resolve each step's Locale (modeled steps only; others are pass-through).
          const localesByArchetype = {};
          for (const step of skeleton.steps) {
            const node = sm.nodes[step.archetypeId];
            if (node?.localeId) {
              const pm = await _readLocaleCache(groundId, node.localeId);
              if (pm?.model) localesByArchetype[step.archetypeId] = pm.model;
            }
          }
          const draft = Workflows.buildWorkflowDraft(skeleton, { localesByArchetype, goals, name });
          const records = CapabilitySynth.buildCapabilityRecords(draft, { groundId, fragmentId: crypto.randomUUID(), strategyId: crypto.randomUUID() });
          if (!records) { sendResponse({ success: false, error: 'could not build workflow records' }); return; }
          await StorageManager.saveFragment(records.fragment);
          await StorageManager.saveStrategy(records.strategy);
          Logger.info('background', `built workflow ${records.strategy.id} "${draft.name.slice(0, 50)}" — ${skeleton.steps.length} step(s), ${draft.actions.length} action(s), runnable=${draft.runnable}${draft.warnings.length ? ` (${draft.warnings.length} warning(s))` : ''}`);
          sendResponse({ success: true, capabilityId: records.strategy.id, name: draft.name, runnable: draft.runnable, steps: draft.steps, warnings: draft.warnings, actionCount: draft.actions.length });
        } catch (err) {
          Logger.error('background', `BUILD_WORKFLOW failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.481 — Ground.chrome (GROUND_SPEC § 4): return the hoisted global chrome set for
    // a ground (promoted features + per-Locale overrides + stats). Read-only; the artifact is
    // re-derived after each Explore. If absent (fewer than 2 modeled Locales), derive on demand.
    case 'GET_GROUND_CHROME': {
      (async () => {
        try {
          const { groundId = null } = payload ?? {};
          if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
          const artifact = (await _readGroundChrome(groundId)) || (await _deriveGroundChrome(groundId));
          if (!artifact) { sendResponse({ success: true, chrome: {}, overrides: {}, chromeLayers: {}, chromeHidden: {}, promotedIds: [], stats: { locales: (await _readAllLocales(groundId)).length, candidates: 0, promoted: 0, layers: 0 }, empty: true }); return; }
          sendResponse({ success: true, ...artifact });
        } catch (err) {
          Logger.error('background', `GET_GROUND_CHROME failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.477 — Locale graph: materialize the modeled archetype's typed edge set
    // (reveals / contains / enables / leadsTo — PAGEMODEL_SPEC § 1) and reconcile its
    // leadsTo destinations against this Ground's siteMap, so a UI can render the page
    // graph AND see which links lead to already-modeled vs unknown archetypes (a
    // discovery gap). Read-only; consumes the pure Core graph API.
    case 'LOCALE_GRAPH': {
      (async () => {
        try {
          const { groundId = null, archetypeId = null } = payload ?? {};
          if (!groundId || !archetypeId) { sendResponse({ success: false, error: 'groundId, archetypeId required' }); return; }
          const sm = await _readSiteMap(groundId);
          const node = sm?.nodes?.[archetypeId];
          if (!node) { sendResponse({ success: false, error: 'archetype not found in siteMap' }); return; }
          if (!node.localeId) { sendResponse({ success: false, error: 'archetype not modeled yet (no Locale) — Explore it first' }); return; }
          const pm = await _readLocaleCache(groundId, node.localeId);
          const model = pm?.model;
          if (!model) { sendResponse({ success: false, error: 'Locale model not found in cache' }); return; }
          const edges = Locale.localeEdges(model);
          const leadsTo = SiteMap.reconcileLeadsTo(Locale.edgesByKind(model, 'leadsTo', edges), sm);
          const counts = edges.reduce((m, e) => { m[e.kind] = (m[e.kind] || 0) + 1; return m; }, {});
          const gaps = leadsTo.filter((e) => e.known === false && e.status !== 'external').length;
          // Node list (id/kind/label) for the layout renderer: features + layers + goals.
          // (leadsTo destinations are URLs, not graph nodes — surfaced via leadsTo/gaps.)
          const nodes = [
            ...Object.values(model.features || {}).map((f) => ({ id: f.id, kind: f.kind, label: f.label || '' })),
            ...Object.values(model.layers || {}).map((l) => ({ id: l.id, kind: 'layer', label: l.kind === 'surface' ? 'surface' : (l.kind || 'layer') })),
            ...Object.values(model.goals || {}).map((g) => ({ id: g.id, kind: 'goal', label: g.label || '' })),
          ];
          // Per-goal achievement paths (depth-aware traversal): each goal's ordered controls,
          // flagging the disclosure trigger that must open a hidden control first (pathToGoal).
          // Enriched with feature/trigger labels + kinds so the UI can render readable steps.
          const goalPaths = Object.values(model.goals || {}).map((g) => {
            const p = Locale.pathToGoal(model, g.id);
            if (!p) return null;
            const steps = p.steps.map((s) => {
              const f = model.features[s.featureId] || {};
              const t = s.trigger ? (model.features[s.trigger] || {}) : null;
              return { featureId: s.featureId, kind: f.kind || null, label: f.label || '', hidden: !!s.hidden, trigger: s.trigger || null, triggerLabel: t ? (t.label || '') : null };
            });
            return { goalId: g.id, label: g.label || '', steps };
          }).filter(Boolean);
          sendResponse({ success: true, nodes, edges, leadsTo, counts, gaps, goalPaths });
        } catch (err) {
          Logger.error('background', `LOCALE_GRAPH failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }


    // v2.74.352 — "Resolve roles": one LLM call returns a CSS selector for each
    // of a perspective's roles (or null to abstain), given screenshot + rich
    // DOM + this Ground's landmark registry. The sidepanel verifies each
    // selector and routes abstentions/failures to manual picking. See
    // DESIGN_resolve_roles.md.
    case 'RESOLVE_PERSPECTIVE_ROLES': {
      (async () => {
        try {
          const { tabId, groundId = null, roles, priorAttempt = null } = payload ?? {};
          if (typeof tabId !== 'number') { sendResponse({ success: false, error: 'tabId required' }); return; }
          if (!Array.isArray(roles) || roles.length === 0) { sendResponse({ success: false, error: 'roles required' }); return; }
          let tabInfo;
          try { tabInfo = await chrome.tabs.get(tabId); }
          catch (e) { sendResponse({ success: false, error: `Tab not found: ${e.message}` }); return; }
          const url = tabInfo?.url ?? '';
          if (!/^https?:/i.test(url)) {
            sendResponse({ success: false, error: 'This page does not allow content scripts (chrome://, extension page, or restricted URL).' });
            return;
          }
          try {
            await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['ContentScripts/contentScript.js'] });
          } catch (e) {
            Logger.warn('background', `RESOLVE_PERSPECTIVE_ROLES: content-script inject failed (continuing): ${e.message}`);
          }
          let snap;
          // v2.74.395 — includeContentBlocks: surface repeating content blocks
          // (cards/tiles/rows) with their class-signature selector, so content
          // roles with no semantic hook can resolve.
          try { snap = await chrome.tabs.sendMessage(tabId, { type: 'DOM_SNAPSHOT_RICH', payload: { includeContentBlocks: true } }, { frameId: 0 }); }   // frameId:0 — top frame only (avoid empty about:blank iframes winning the race)
          catch (e) { sendResponse({ success: false, error: `DOM snapshot failed: ${e.message}` }); return; }
          if (!snap?.success) { sendResponse({ success: false, error: snap?.error ?? 'DOM snapshot returned no payload' }); return; }

          // Screenshot (active tab only) — best-effort.
          let screenshot = null;
          if (tabInfo.active) {
            try { screenshot = await chrome.tabs.captureVisibleTab(tabInfo.windowId, { format: 'jpeg', quality: 55 }); }
            catch (e) { Logger.warn('background', `RESOLVE_PERSPECTIVE_ROLES: screenshot failed (continuing): ${e.message}`); }
          }
          // Ground landmark registry (reuse) — best-effort.
          let registryLandmarks = null;
          if (groundId) {
            try {
              const lms = await StorageManager.listLandmarksForGround(groundId);
              registryLandmarks = (lms ?? []).map(lm => ({ alias: lm.alias, a11yRole: lm.a11yRole, description: lm.description, selector: lm.selector }));
            } catch (e) {
              Logger.warn('background', `RESOLVE_PERSPECTIVE_ROLES: listLandmarksForGround failed (continuing): ${e.message}`);
            }
          }

          // v2.74.385 — verified selectors from the page-exploration artifact,
          // so resolve REUSES proven selectors (esp. for triggers) instead of
          // guessing positional ones on hashed-class pages.
          const knownSelectors = await _knownSelectorsForUrl(groundId, snap.url ?? url);
          Logger.info('explore', `RESOLVE_PERSPECTIVE_ROLES: ${Array.isArray(knownSelectors) ? knownSelectors.length : 0} known verified selector(s) from artifact${Array.isArray(knownSelectors) && knownSelectors.length ? ' — e.g. ' + knownSelectors.slice(0, 6).map(k => `"${(k.label || '').slice(0, 24)}"`).join(', ') : ' (none — page not explored, or Explore did not capture these controls)'}`);

          // v2.74.415 — OUTCOMES slice 4: the conventions histogram (selector-tier
          // distribution learned from this Ground's verified selectors, § 6) biases
          // the next resolve — each Perspective built makes the next cheaper/accurate.
          let conventions = null;
          if (groundId) {
            try {
              const conv = (await _outcomeRollups(groundId)).conventions;
              if (conv && conv.total >= 5) conventions = conv;   // only once there's signal
            } catch (e) { Logger.warn('background', `RESOLVE_PERSPECTIVE_ROLES: conventions read failed (continuing): ${e.message}`); }
          }

          // PB-2 (R4) resolve-by-reuse: roles the proposal grounded to a real feature (featureId)
          // bind directly to that feature's selector — skip the LLM for them. The INSPECT verify in
          // the sidepanel still runs, so a stale reused selector is caught and can be retried (retry
          // sends no featureId → LLM repair). Only UNGROUNDED roles hit the LLM here.
          let localeModel = null;
          if (groundId) {
            try { const pm = await _readLocaleCache(groundId, _normalizeUrlForPerspectiveCache(snap.url ?? url)); localeModel = pm?.model || null; }
            catch (e) { Logger.warn('background', `RESOLVE_PERSPECTIVE_ROLES: locale read for reuse failed (continuing): ${e.message}`); }
          }
          const reused = [];
          const toResolve = [];
          for (const r of roles) {
            const fid = (r && typeof r.featureId === 'string') ? r.featureId : null;
            const f = (fid && localeModel?.features) ? localeModel.features[fid] : null;
            if (r && typeof r.selector === 'string' && r.selector) {
              // PB-10 — oracle-bound form field: bind directly to the page's real control selector,
              // skipping the LLM (which guesses MUI wrappers). INSPECT verify in the sidepanel still runs.
              reused.push({ role: r.role, selector: r.selector, confidence: 0.9, justification: `oracle: form ${r.fieldKind || 'field'}`, reuse: true });
            } else if (f && f.selector) {
              reused.push({ role: r.role, selector: f.selector, confidence: f.selectorVerified ? 0.95 : 0.7, justification: `reuse: feature ${fid}${f.selectorVerified ? ' (verified)' : ''}`, featureId: fid, reuse: true });
            } else {
              toResolve.push(r);
            }
          }
          let llmResolutions = [];
          if (toResolve.length) {
            const out = await AnthropicService.resolveRoles({
              roles      : toResolve,
              url        : snap.url   ?? url,
              title      : snap.title ?? '',
              domSnapshot: snap.snapshot ?? '',
              screenshot,
              registryLandmarks,
              knownSelectors,
              conventions,
              priorAttempt,
            });
            if (out && Array.isArray(out.resolutions)) llmResolutions = out.resolutions;
            else if (!reused.length) { sendResponse({ success: false, error: 'Claude returned no usable resolutions.' }); return; }
          }
          // Merge preserving the original role order (reused first, then LLM).
          const byRole = new Map();
          for (const x of reused) byRole.set(x.role, x);
          for (const x of llmResolutions) if (!byRole.has(x.role)) byRole.set(x.role, x);
          const resolutions = roles.map(r => byRole.get(r.role) || { role: r.role, selector: null, confidence: 0, justification: 'unresolved' });
          Logger.info('explore', `RESOLVE_PERSPECTIVE_ROLES: ${reused.length} reused (feature-grounded), ${toResolve.length} via LLM`);
          sendResponse({ success: true, resolutions, reusedCount: reused.length });
        } catch (err) {
          Logger.error('background', `RESOLVE_PERSPECTIVE_ROLES failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // (RUN_PERSPECTIVE_TRIAL lived here until v2.74.950 — CR-X3 migrated it into the registry beside
    // its twin RUN_SG_TRIAL in background/handlers/sg.js.)

    // SG-5 / PB-7 — RUN_SG_TRIAL, ACCEPT_SG_TRIAL, REPLAY_SG_CAPABILITY moved to the registry (background/handlers/sg.js, R1).

    // v2.74.381 — Reveal-aware resolve. Roles that live in a hidden layer (a
    // modal/menu) can't resolve against the static DOM. Open the trigger, snapshot
    // the REVEALED state, resolve the hidden roles against it, verify each WHILE
    // OPEN, then close. Trigger selector comes from the resolved trigger role
    // (structured) or, when absent, the Locale's disclosure features.
    // Payload: { tabId, groundId?, triggerSelector?, triggerLabel?, roles } →
    //          { success, resolutions:[{role,selector,confidence,justification,matchedCount}], trigger }
    case 'RESOLVE_REVEALED_ROLES': {
      (async () => {
        try {
          const { tabId, groundId = null, triggerSelector = null, triggerLabel = null, roles } = payload ?? {};
          if (typeof tabId !== 'number') { sendResponse({ success: false, error: 'tabId required' }); return; }
          if (!Array.isArray(roles) || !roles.length) { sendResponse({ success: false, error: 'roles required' }); return; }
          let tabInfo;
          try { tabInfo = await chrome.tabs.get(tabId); }
          catch (e) { sendResponse({ success: false, error: `Tab not found: ${e.message}` }); return; }
          const url = tabInfo?.url ?? '';
          if (!/^https?:/i.test(url)) { sendResponse({ success: false, error: 'restricted URL' }); return; }
          try { await chrome.scripting.executeScript({ target: { tabId }, files: ['ContentScripts/contentScript.js'] }); } catch { /* */ }

          // Resolve the trigger selector: prefer the one passed (the resolved
          // trigger role), else match the Locale's disclosure features (v2.74.426 #2 P3 —
          // was the pageStructure artifact; the sweep's triggers live on the Locale now).
          let trigger = (typeof triggerSelector === 'string' && triggerSelector) ? triggerSelector : null;
          if (!trigger && groundId) {
            try {
              const pm = await _readLocaleCache(groundId, _normalizeUrlForPerspectiveCache(url));
              const layers = pm?.model?.layers || {};
              const discs = (pm?.model?.features ? Object.values(pm.model.features) : [])
                .filter(f => f?.kind === 'disclosure' && f?.selector && f?.reveals);
              const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
              const want = norm(triggerLabel).split(' ').filter(Boolean);
              let best = null;
              if (want.length) best = discs.find(f => { const l = norm(f.label); return want.some(w => w.length > 2 && l.includes(w)); });
              if (!best) best = discs.find(f => layers[f.reveals]?.overlay) || discs[0];
              trigger = best?.selector ?? null;
              if (trigger) Logger.info('explore', `RESOLVE_REVEALED_ROLES: trigger from Locale = "${(best.label || '').slice(0, 40)}"`);
            } catch (e) { Logger.warn('background', `RESOLVE_REVEALED_ROLES Locale lookup failed: ${e.message}`); }
          }
          if (!trigger) { sendResponse({ success: false, error: 'no trigger to reveal the hidden layer — resolve the trigger role first, or run Explore' }); return; }

          Logger.info('explore', `RESOLVE_REVEALED_ROLES: trigger="${String(trigger).slice(0, 80)}" for ${roles.length} hidden role(s): ${roles.map(r => r.role).join(', ')}`);

          // Open the trigger and snapshot the revealed state (leaves it open).
          let snap;
          try { snap = await chrome.tabs.sendMessage(tabId, { type: 'POKE_AND_SNAPSHOT', payload: { selector: trigger } }, { frameId: 0 }); }
          catch (e) { sendResponse({ success: false, error: `reveal failed: ${e.message}` }); return; }
          if (!snap?.success) { sendResponse({ success: false, error: snap?.error ?? 'reveal returned no snapshot' }); return; }
          if (snap.navigated) { Logger.warn('explore', 'RESOLVE_REVEALED_ROLES: trigger NAVIGATED instead of revealing — aborting'); sendResponse({ success: false, error: 'trigger navigated to another page instead of opening a layer' }); return; }
          Logger.info('explore', `RESOLVE_REVEALED_ROLES: poked trigger → opened ${snap.opened ?? '?'} new element(s), snapshot ${String(snap.snapshot || '').length} chars`);
          if (!snap.opened) Logger.warn('explore', 'RESOLVE_REVEALED_ROLES: poke revealed NOTHING — the trigger selector may not be the actual opener (resolving against the unchanged DOM)');

          let screenshot = null;
          if (tabInfo.active) {
            try { screenshot = await chrome.tabs.captureVisibleTab(tabInfo.windowId, { format: 'jpeg', quality: 55 }); }
            catch (e) { Logger.warn('background', `RESOLVE_REVEALED_ROLES screenshot failed (continuing): ${e.message}`); }
          }

          // Reuse the artifact's verified revealed-child selectors for the
          // hidden roles (the modal's buttons were captured during exploration).
          const knownSelectors = await _knownSelectorsForUrl(groundId, snap.url ?? url);
          Logger.info('explore', `RESOLVE_REVEALED_ROLES: ${Array.isArray(knownSelectors) ? knownSelectors.length : 0} known verified selector(s) from artifact`);
          const out = await AnthropicService.resolveRoles({
            roles, url: snap.url ?? url, title: snap.title ?? '', domSnapshot: snap.snapshot ?? '', screenshot, registryLandmarks: null, knownSelectors, priorAttempt: null,
          });
          const resolutions = Array.isArray(out?.resolutions) ? out.resolutions : [];

          // Verify each selector WHILE the layer is still open — via INSPECT so
          // we also capture the report needed to profile the hidden landmark
          // (description/ops/pitfalls); the element is gone once the modal closes.
          for (const r of resolutions) {
            if (!r || !r.selector) { if (r) r.matchedCount = 0; continue; }
            try {
              const ins = await chrome.tabs.sendMessage(tabId, { type: 'INSPECT_ELEMENT', payload: { target: r.selector, pickLast: false } }, { frameId: 0 });
              if (ins?.success && ins.report) { r.matchedCount = ins.report.matchCount ?? 1; r.inspect = ins.report; }
              else r.matchedCount = 0;
            } catch { r.matchedCount = 0; }
            Logger.info('explore', `RESOLVE_REVEALED_ROLES[${r.role}]: ${r.selector ? `"${String(r.selector).slice(0, 70)}" → matched ${r.matchedCount}` : 'abstained'}`);
          }

          // Restore the page.
          try { await chrome.tabs.sendMessage(tabId, { type: 'CLOSE_OVERLAYS' }, { frameId: 0 }); } catch { /* */ }

          Logger.info('explore', `RESOLVE_REVEALED_ROLES done: ${resolutions.filter(r => r?.selector && r.matchedCount > 0).length}/${roles.length} verified in revealed layer`);
          sendResponse({ success: true, resolutions, trigger });
        } catch (err) {
          Logger.error('background', `RESOLVE_REVEALED_ROLES failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.396 — Resolve Tier-2 VISUAL fallback ("Path C"): for a role the DOM
    // resolve pass couldn't pin down, look at the page and locate it by region.
    // Capture the viewport → ask the vision model for a normalized box of the
    // element that plays the role → hit-test the box to a real element (IoU) in
    // the content script → return the picker-shaped result. The sidepanel then
    // runs the Pick→Claude refine on it. Payload: { tabId, groundId?, role:{role,
    // description, multiplicity}, intent } → { success, found, box?, confidence?,
    // pick? } | { success:false, error }.
    case 'RESOLVE_ROLE_VISUAL': {
      (async () => {
        try {
          const { tabId, groundId = null, role, intent = '' } = payload ?? {};
          if (typeof tabId !== 'number') { sendResponse({ success: false, error: 'tabId required' }); return; }
          if (!role || !role.role) { sendResponse({ success: false, error: 'role required' }); return; }
          let tabInfo;
          try { tabInfo = await chrome.tabs.get(tabId); }
          catch (e) { sendResponse({ success: false, error: `Tab not found: ${e.message}` }); return; }
          const url = tabInfo?.url ?? '';
          if (!/^https?:/i.test(url)) { sendResponse({ success: false, error: 'restricted URL' }); return; }
          try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['ContentScripts/contentScript.js'] }); } catch { /* */ }
          // The locate is purely visual → needs a screenshot of the active tab.
          let screenshot = null;
          if (tabInfo.active) {
            try { screenshot = await chrome.tabs.captureVisibleTab(tabInfo.windowId, { format: 'jpeg', quality: 60 }); }
            catch (e) { Logger.warn('background', `RESOLVE_ROLE_VISUAL screenshot failed: ${e.message}`); }
          }
          if (!screenshot) { sendResponse({ success: true, found: false, note: 'no screenshot (tab not the active one in its window)' }); return; }
          // Reuse the Locale's page-affordance description for grounding context.
          let affordances = null;
          if (groundId) {
            try { const pm = await _readLocaleCache(groundId, _normalizeUrlForPerspectiveCache(url)); affordances = pm?.model?.affordances ?? null; } catch { /* */ }
          }
          const loc = await AnthropicService.locateRoleRegion({
            role: role.role, description: role.description ?? '', intent,
            affordances, url, title: tabInfo.title ?? '', screenshot,
          });
          if (!loc) { sendResponse({ success: false, error: 'visual locate call failed' }); return; }
          if (!loc.found || !loc.box) {
            sendResponse({ success: true, found: false, confidence: loc.confidence ?? 0, note: loc.note || 'role not visible in the current view' });
            return;
          }
          let pick;
          try { pick = await chrome.tabs.sendMessage(tabId, { type: 'LOCATE_PICK', payload: { box: loc.box } }, { frameId: 0 }); }
          catch (e) { sendResponse({ success: false, error: `locate-pick failed: ${e.message}` }); return; }
          if (!pick?.success) {
            sendResponse({ success: true, found: false, box: loc.box, confidence: loc.confidence, note: pick?.error || 'no element matched the located region' });
            return;
          }
          Logger.info('explore', `RESOLVE_ROLE_VISUAL[${role.role}]: box conf=${loc.confidence} → "${String(pick.selector).slice(0, 70)}" (IoU ${typeof pick.iou === 'number' ? pick.iou.toFixed(2) : '?'}, matched ${pick.matchedCount})`);
          sendResponse({ success: true, found: true, box: loc.box, confidence: loc.confidence, pick });
        } catch (err) {
          Logger.error('background', `RESOLVE_ROLE_VISUAL failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.397 — Read a cached Locale (no enumeration). Payload: { groundId, url }
    //   → { success, model|null, fresh, capturedAt? }.
    case 'GET_LOCALE': {
      (async () => {
        try {
          const { groundId = null, url } = payload ?? {};
          if (!groundId || !url) { sendResponse({ success: true, model: null, fresh: false }); return; }
          const entry = await _readLocaleCache(groundId, _normalizeUrlForPerspectiveCache(url));
          if (!entry?.model) { sendResponse({ success: true, model: null, fresh: false }); return; }
          const fresh = (Date.now() - (entry.capturedAt ?? 0)) < LOCALE_TTL_MS;
          sendResponse({ success: true, model: entry.model, fresh, capturedAt: entry.capturedAt });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.431 — Ground siteMap (GROUND_SPEC § 7). Read-only; consumed by the
    // studio Site Map viewer. → { success, siteMap|null, stats }.
    case 'GET_SITEMAP': {
      (async () => {
        try {
          const { groundId = null } = payload ?? {};
          if (!groundId) { sendResponse({ success: true, siteMap: null, stats: null }); return; }
          const siteMap = await _readSiteMap(groundId);
          sendResponse({ success: true, siteMap, stats: siteMap ? SiteMap.siteMapStats(siteMap) : null });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.413 — OUTCOMES slice 2: read the append-only stream + its lazily
    // folded rollups (Feature.health / Perspective.usage / Ground.conventions).
    // Read-only; consumed by the studio viewer (slice 5) and resolve bias / decay
    // (slice 4). `includeEvents` returns the raw stream too (capped for transport).
    case 'GET_OUTCOMES': {
      (async () => {
        try {
          const { groundId = null, includeEvents = false, limit = 200 } = payload ?? {};
          if (!groundId) { sendResponse({ success: true, rollups: null, events: [], eventCount: 0 }); return; }
          const rollups = await _outcomeRollups(groundId);
          let events = [];
          if (includeEvents) {
            const stream = await _readOutcomes(groundId);
            events = stream.slice(-limit).reverse();   // newest first
          }
          sendResponse({ success: true, rollups, events, eventCount: rollups.eventCount });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.414 — OUTCOMES slice 3: emit hook. The sidepanel's resolve-run
    // (`_logResolveRun`) ships its perf entry here; we transform each per-role
    // detail into an authoring `resolve` OutcomeEvent (OUTCOMES_SPEC § 9 — the
    // gold `corrected` label rides along when a row carries `humanFinal`) and
    // append it to the ground's stream. Centralizing the write in background
    // avoids read-modify-write races on the shared `outcomesStream` map.
    case 'EMIT_RESOLVE_OUTCOMES': {
      (async () => {
        try {
          const { groundId = null, run = null, ctx = {} } = payload ?? {};
          if (!groundId || !run) { sendResponse({ success: true, emitted: 0 }); return; }

          // v2.74.415 — map each resolved/corrected selector to its catalog
          // Feature id so Feature.health keys land (slice 4). Build a verbatim
          // selector→id index from the cached locale for this ground+URL.
          let selToFid = null, localeEntry = null, localeKey = null;
          try {
            localeKey = _normalizeUrlForPerspectiveCache(run.url ?? ctx.localeId ?? '');
            localeEntry = await _readLocaleCache(groundId, localeKey);
            const feats = localeEntry?.model?.features ? Object.values(localeEntry.model.features) : [];
            if (feats.length) {
              selToFid = new Map();
              for (const f of feats) if (f?.selector && f?.id && !selToFid.has(f.selector)) selToFid.set(f.selector, f.id);
            }
          } catch (e) { Logger.warn('background', `EMIT_RESOLVE_OUTCOMES: locale index failed (continuing): ${e.message}`); }

          const featureIdForRole = (_role, selector) => (selector && selToFid ? (selToFid.get(selector) ?? null) : null);
          const events = Outcomes.eventsFromResolveRun(run, { groundId, ...ctx, featureIdForRole });
          await _appendOutcomes(groundId, events);
          Logger.info('outcomes', `resolve-run → ${events.length} event(s) for ground ${groundId}`);

          // v2.74.415 — active decay (OUTCOMES_SPEC § 7, GROUND_SPEC § 0.16). Fold
          // the full stream's Feature health and push decayed confidence/lifecycle
          // back onto the cached locale features — a resolve-miss flags JUST
          // that feature stale-suspected, never its siblings. Write back if changed.
          try {
            if (localeEntry?.model?.features) {
              const feats = localeEntry.model.features;
              const health = (await _outcomeRollups(groundId)).featureHealth;
              let changed = 0;
              for (const [fid, f] of Object.entries(feats)) {
                const h = health[fid];
                if (!h) continue;
                const d = Outcomes.decayFeature(f, h);
                // v2.74.496 — persist lastDecayedAt so age decay is INCREMENTAL across writebacks
                // (doesn't re-decay the already-decayed value on repeated resolve-runs).
                if (d.changed) { f.confidence = d.confidence; f.lifecycle = d.lifecycle; f.lastDecayedAt = d.lastDecayedAt; changed++; }
              }
              // v2.74.419 — provenance: stamp `correctedByHuman` ON the catalog
              // Feature the LLM wrongly proposed (OUTCOMES_SPEC § 3 — the gold label
              // as durable artifact provenance, not only a stream row). featureId
              // for a `corrected` event already points at the PROPOSED (wrong)
              // element; record { role, from→to, at } + the corpusRef backlink.
              for (const ev of events) {
                if (ev.verdict !== 'corrected' || !ev.featureId) continue;
                const f = feats[ev.featureId];
                if (!f) continue;
                f.provenance = f.provenance || {};
                f.provenance.proposedBy = f.provenance.proposedBy || 'llm-resolve';
                f.provenance.correctedByHuman = {
                  role: ev.role ?? null,
                  from: ev.llmOutput?.selector ?? null,
                  to: ev.humanFinal?.selector ?? null,
                  at: ev.ts,
                };
                if (ev.corpusRef) f.provenance.corpusRef = ev.corpusRef;
                changed++;
              }
              if (changed) {
                await _writeLocaleCache(groundId, localeKey, localeEntry);
                Logger.info('outcomes', `locale ${localeKey}: ${changed} feature update(s) (decay + provenance)`);
              }
            }
          } catch (e) { Logger.warn('background', `EMIT_RESOLVE_OUTCOMES: decay/provenance pass failed (continuing): ${e.message}`); }

          sendResponse({ success: true, emitted: events.length });
        } catch (err) {
          Logger.warn('background', `EMIT_RESOLVE_OUTCOMES failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.353 — Resolve-roles complexity metric. Injects the content script
    // (so tabs loaded before this session answer) then asks it to scan the DOM
    // and score how hard the page is to resolve. Used for the side-panel badge.
    case 'GET_PAGE_COMPLEXITY': {
      (async () => {
        try {
          const { tabId } = payload ?? {};
          if (typeof tabId !== 'number') { sendResponse({ success: false, error: 'tabId required' }); return; }
          let tabInfo;
          try { tabInfo = await chrome.tabs.get(tabId); }
          catch (e) { sendResponse({ success: false, error: `Tab not found: ${e.message}` }); return; }
          if (!/^https?:/i.test(tabInfo?.url ?? '')) {
            sendResponse({ success: false, error: 'not-a-web-page' });
            return;
          }
          try {
            await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ['ContentScripts/contentScript.js'] });
          } catch (e) {
            Logger.warn('background', `GET_PAGE_COMPLEXITY: inject failed (continuing): ${e.message}`);
          }
          let res;
          try { res = await chrome.tabs.sendMessage(tabId, { type: 'PAGE_COMPLEXITY' }, { frameId: 0 }); }
          catch (e) { sendResponse({ success: false, error: `complexity scan failed: ${e.message}` }); return; }
          if (!res?.success) { sendResponse({ success: false, error: res?.error ?? 'no complexity report' }); return; }
          sendResponse({ success: true, report: res.report });
        } catch (err) {
          Logger.error('background', `GET_PAGE_COMPLEXITY failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.364 — Visual-critic escalation for structure verification: capture
    // the (post-poke) page state + adjudicate the residual claims deterministic
    // checks couldn't settle. See DESIGN_resolve_roles / structure verify notes.
    case 'ADJUDICATE_STRUCTURE': {
      (async () => {
        try {
          const { tabId, claims } = payload ?? {};
          if (typeof tabId !== 'number') { sendResponse({ success: false, error: 'tabId required' }); return; }
          if (!Array.isArray(claims) || !claims.length) { sendResponse({ success: false, error: 'claims required' }); return; }
          let tabInfo;
          try { tabInfo = await chrome.tabs.get(tabId); }
          catch (e) { sendResponse({ success: false, error: `Tab not found: ${e.message}` }); return; }
          let screenshot = null;
          if (tabInfo.active) {
            try { screenshot = await chrome.tabs.captureVisibleTab(tabInfo.windowId, { format: 'jpeg', quality: 60 }); }
            catch (e) { Logger.warn('background', `ADJUDICATE_STRUCTURE: screenshot failed (continuing): ${e.message}`); }
          }
          const out = await AnthropicService.adjudicateStructure({ claims, screenshot });
          if (!out || !Array.isArray(out.verdicts)) { sendResponse({ success: false, error: 'no verdicts' }); return; }
          sendResponse({ success: true, verdicts: out.verdicts });
        } catch (err) {
          Logger.error('background', `ADJUDICATE_STRUCTURE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.128 — GET_TAB_SIDEPANEL_MODE and the background-side
    // CLEAR_TAB_SIDEPANEL_MODE handler removed alongside the dead
    // __tabSidepanelModes map. The shell registers its own
    // CLEAR_TAB_SIDEPANEL_MODE handler in Sidepanel/shell.js that
    // updates the authoritative `_tabModes` map; callers' messages
    // still reach that handler unchanged.

    // v2.72.52 (Stage 3 / fragment-walk) — Exit to Studio.
    //
    // The intended UX commitment (v2.72.54): the cancel/close button in
    // ANY mode dismisses the sidepanel and returns focus to Studio.
    // Steps:
    //   1. Clear the active sidepanel mode (broadcast unmounts the mode)
    //   2. Disable the sidepanel on the current tab so it physically
    //      closes (Chrome has no close() API; setOptions({enabled:false})
    //      is the official mechanism)
    //   3. Find or open Studio in a tab and focus it
    //
    // The sidepanel re-enables itself the next time a launcher (Studio's
    // ▶, + Perspective, Walk button) calls setOptions({enabled:true}) before
    // sidePanel.open. That setOptions call effectively re-arms the panel
    // for the relevant tab.
    // v2.74.1013 — close tabs from the extension. scope 'tab' = a SPECIFIC tab (the one passed); scope 'all'
    // = GLOBAL reset — keep exactly ONE Studio tab (find it, else create it) and close every other tab in
    // every window. Reuses EXIT_TO_STUDIO's Studio find-or-create. Destructive for scope 'all', so the
    // panel gates it behind a confirm; the handler itself is the mechanism.
    case 'CLOSE_TABS': {
      (async () => {
        try {
          const { scope = 'all', tabId = null, site = '' } = payload ?? {};
          if (scope === 'tab') {
            if (typeof tabId !== 'number') { sendResponse({ success: false, error: 'tabId required for scope=tab' }); return; }
            try { await chrome.tabs.remove(tabId); } catch (e) { sendResponse({ success: false, error: e.message }); return; }
            Logger.info('background', `CLOSE_TABS ▸ scope=tab → closed ${tabId}`);
            sendResponse({ success: true, closed: 1 });
            return;
          }
          // v2.74.1021 — scope 'site' = close every tab whose HOST matches the named site (e.g. "youtube" →
          // www.youtube.com, m.youtube.com), never the Studio tab. Label-based match (a host LABEL equals the
          // token, or the bare host equals/starts-with it) so "youtube" hits youtube.com but not notyoutube.com.
          if (scope === 'site') {
            const want = String(site || '').toLowerCase().trim();
            if (!want) { sendResponse({ success: false, error: 'site required for scope=site' }); return; }
            const studioUrl = chrome.runtime.getURL('studio.html');
            const all = await chrome.tabs.query({});
            const toClose = all.filter((t) => {
              if (!t || typeof t.id !== 'number' || !t.url) return false;
              if (t.url.startsWith(studioUrl)) return false;   // never close Studio
              let host = '';
              try { host = new URL(t.url).hostname.toLowerCase(); } catch { return false; }
              const bare = host.replace(/^www\./, '');
              return host === want || bare === want || bare.startsWith(`${want}.`) || bare.split('.').includes(want);
            }).map((t) => t.id);
            let closed = 0;
            if (toClose.length) { try { await chrome.tabs.remove(toClose); closed = toClose.length; } catch (e) { Logger.warn('background', `CLOSE_TABS site remove partial: ${e.message}`); } }
            Logger.info('background', `CLOSE_TABS ▸ scope=site "${want}" → closed ${closed}`);
            sendResponse({ success: true, closed, site: want });
            return;
          }
          // scope 'all' — keep exactly one Studio tab (find or create), close the rest (all windows).
          const studioUrl = chrome.runtime.getURL('studio.html');
          const studios = await chrome.tabs.query({ url: studioUrl });
          let keepId = (studios[0] && typeof studios[0].id === 'number') ? studios[0].id : null;
          if (keepId == null) {
            const t = await new Promise((r) => { try { chrome.tabs.create({ url: studioUrl, active: true }, (tt) => { void chrome.runtime.lastError; r(tt || null); }); } catch { r(null); } });
            keepId = (t && typeof t.id === 'number') ? t.id : null;
          } else {
            try { await chrome.tabs.update(keepId, { active: true }); } catch { /* */ }
          }
          const all = await chrome.tabs.query({});
          const toClose = all.filter((t) => t && typeof t.id === 'number' && t.id !== keepId).map((t) => t.id);
          let closed = 0;
          if (toClose.length) { try { await chrome.tabs.remove(toClose); closed = toClose.length; } catch (e) { Logger.warn('background', `CLOSE_TABS remove partial: ${e.message}`); } }
          Logger.info('background', `CLOSE_TABS ▸ scope=all → kept Studio tab ${keepId}, closed ${closed}`);
          sendResponse({ success: true, closed, keptStudioTab: keepId });
        } catch (err) {
          Logger.warn('background', `CLOSE_TABS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'EXIT_TO_STUDIO': {
      (async () => {
        try {
          // v2.72.59 — Sidepanel is opened with windowId scope by all
          // launchers. Close with windowId scope to match. Mixing tabId
          // close attempts hits a different (non-existent) panel instance
          // and silently no-ops while reporting success.
          let panelWindowId = payload?.windowId ?? null;
          if (panelWindowId == null) {
            try {
              const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
              panelWindowId = activeTab?.windowId ?? null;
            } catch (_) { /* fine */ }
          }
          Logger.info('background', `EXIT_TO_STUDIO target wid:${String(panelWindowId)} payloadHas:${!!payload?.windowId}`);

          // Step 1: Clear mode (broadcasts SIDEPANEL_MODE_CHANGED → shell unmounts)
          __setSidepanelMode(null, null);

          // Step 2: Close the global sidepanel for this window.
          if (typeof chrome.sidePanel?.close === 'function' && panelWindowId != null) {
            try {
              await chrome.sidePanel.close({ windowId: panelWindowId });
              Logger.info('background', `EXIT_TO_STUDIO close-call(win) OK wid:${String(panelWindowId)}`);
            } catch (e) {
              Logger.warn('background', `EXIT_TO_STUDIO close-call(win) threw: ${e.message}`);
            }
          } else {
            Logger.warn('background', `EXIT_TO_STUDIO close-fn unavailable typeof:${typeof chrome.sidePanel?.close} wid:${String(panelWindowId)}`);
          }

          // Step 3: Focus Studio (find existing tab or open one)
          const studioUrl = chrome.runtime.getURL('studio.html');
          const tabs = await chrome.tabs.query({ url: studioUrl });
          if (tabs.length > 0) {
            const tab = tabs[0];
            await chrome.tabs.update(tab.id, { active: true });
            if (tab.windowId != null) {
              await chrome.windows.update(tab.windowId, { focused: true });
            }
          } else {
            await chrome.tabs.create({ url: studioUrl, active: true });
          }
          sendResponse({ success: true });
        } catch (err) {
          Logger.warn('background', `EXIT_TO_STUDIO failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.72.41 (Pass 17g) — Perspective capture handoff to debugger.
    case 'BEGIN_PERSPECTIVE_CAPTURE': {
      (async () => {
        try {
          // v2.74.31 — Optional existingTabId reuses the user's current
          // tab (sidepanel-launched capture) instead of open/find-by-URL.
          // v2.74.33 — Optional returnTo decides where Save / Cancel goes.
          // v2.74.43 — Optional prefilledPerspective seeds name + description
          // + landmarks (Claude-suggested via AUTO_DISCOVER_PERSPECTIVE).
          const { groundId, existingTabId = null, returnTo = null, prefilledPerspective = null } = payload ?? {};
          if (!groundId) {
            sendResponse({ success: false, error: 'groundId required' });
            return;
          }
          // Refuse if a debug invocation is active.
          if (__activeInvocations.size > 0) {
            sendResponse({
              success: false,
              error: 'A strategy is currently running under the debugger. Cancel or finish it before capturing a perspective.',
            });
            return;
          }
          if (__pendingPerspectiveCapture) {
            sendResponse({
              success: false,
              error: 'Another perspective capture is already in progress. Cancel it from the debugger first.',
            });
            return;
          }

          // Look up the Ground for its URL.
          const ground = await StorageManager.getGround(groundId);
          if (!ground) {
            sendResponse({ success: false, error: `Ground ${groundId} not found` });
            return;
          }
          if (!ground.url && existingTabId == null) {
            sendResponse({ success: false, error: 'Ground has no URL — cannot open a starting tab' });
            return;
          }

          // v2.74.31 — Reuse the caller-provided tab when given; otherwise
          // find or open one matching the Ground's stored URL.
          let tabRes;
          if (existingTabId != null) {
            try { await chrome.tabs.update(existingTabId, { active: true }); } catch (e) {
              Logger.warn('background', `BEGIN_PERSPECTIVE_CAPTURE: focus tab ${existingTabId} failed: ${e.message}`);
            }
            tabRes = { ok: true, tabId: existingTabId };
          } else {
            tabRes = await __findOrOpenTabForPerspective(ground.url);
          }
          if (!tabRes.ok) {
            sendResponse({ success: false, error: tabRes.error });
            return;
          }

          // Stash session.
          __pendingPerspectiveCapture = {
            groundId,
            tabId: tabRes.tabId,
            sessionId: `perspective_cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            startedAt: Date.now(),
          };

          try {
            await chrome.sidePanel.setOptions({
              tabId: tabRes.tabId,
              // v2.72.50 (Stage 1) — use the new shell HTML. Shell will
              // route to the perspective-capture mode based on the mode set
              // below. Old per-tab debugger.html assignment retired.
              path: 'sidepanel.html',
              enabled: true,
            });
          } catch (e) {
            Logger.warn('background', `BEGIN_PERSPECTIVE_CAPTURE: setOptions failed (non-fatal): ${e.message}`);
          }

          // v2.72.44 — Wait for tab complete + re-inject content script.
          // v2.74.166 — allFrames: true so perspective-capture's frame-aware
          // picker broadcast actually reaches iframes (the picker now
          // routes through shared.js broadcastStartPick).
          await __waitForTabComplete(tabRes.tabId, 8000);
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tabRes.tabId, allFrames: true },
              files: ['ContentScripts/contentScript.js'],
            });
            Logger.info('background', `BEGIN_PERSPECTIVE_CAPTURE: re-injected content script into tab ${tabRes.tabId} (all frames)`);
          } catch (e) {
            Logger.warn('background', `BEGIN_PERSPECTIVE_CAPTURE: executeScript failed (continuing): ${e.message}`);
          }

          // v2.72.50 (Stage 1) — Set the sidepanel mode. The shell
          // listens for SIDEPANEL_MODE_CHANGED (broadcast by
          // __setSidepanelMode) and mounts perspective-capture.js. The
          // legacy PERSPECTIVE_CAPTURE_BEGIN_BROADCAST is preserved for
          // backward compatibility with the not-yet-extracted
          // debugger.html flows in the interim.
          __setSidepanelMode('perspective-capture', {
            groundId,
            tabId: tabRes.tabId,
            sessionId: __pendingPerspectiveCapture.sessionId,
            returnTo,
            prefilledPerspective,
          });
          chrome.runtime.sendMessage({
            type: 'PERSPECTIVE_CAPTURE_BEGIN_BROADCAST',
            payload: {
              session: __pendingPerspectiveCapture,
            },
          }).catch(() => { /* no listeners is fine */ });

          sendResponse({
            success: true,
            tabId: tabRes.tabId,
            sessionId: __pendingPerspectiveCapture.sessionId,
          });
        } catch (err) {
          Logger.error('background', `BEGIN_PERSPECTIVE_CAPTURE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'GET_PENDING_PERSPECTIVE_CAPTURE': {
      // Synchronous reply — debugger polls this on boot. No async work.
      sendResponse({
        success: true,
        session: __pendingPerspectiveCapture ? { ...__pendingPerspectiveCapture } : null,
      });
      return false;
    }

    case 'CANCEL_PERSPECTIVE_CAPTURE': {
      // Clear pending session. Used when:
      //  - debugger commits a save (followup after SAVE_PERSPECTIVE success)
      //  - user explicitly cancels in the debugger
      //  - studio cancels its handoff
      const cleared = __pendingPerspectiveCapture;
      __pendingPerspectiveCapture = null;
      Logger.info('background', `CANCEL_PERSPECTIVE_CAPTURE: cleared session`, {
        hadSession: !!cleared,
        sessionId: cleared?.sessionId,
      });
      // v2.72.50 (Stage 1) — also clear the sidepanel mode if the
      // current mode is perspective-capture. The shell unmounts and shows
      // idle. (If the user already switched to a different mode, leave
      // that mode alone.)
      if (__sidepanelMode === 'perspective-capture') {
        __setSidepanelMode(null, null);
      }
      sendResponse({ success: true, hadSession: !!cleared });
      return false;
    }

    // v2.49.0 — Look up a specific invocation by id, regardless of status.
    // Used by the debugger to adopt invocations whose `started` event was
    // missed (cold-start race after extension reload). Returns the same
    // metadata shape as GET_ACTIVE_DEBUG_INVOCATION but doesn't filter by
    // status, so a failed/completed invocation can still be adopted for
    // display purposes.
    case 'GET_DEBUG_INVOCATION_BY_ID': {
      const invocationId = message.payload?.invocationId;
      if (!invocationId) {
        sendResponse({ success: false, error: 'invocationId required' });
        return false;
      }
      (async () => {
        try {
          const list = await CapabilityAPI.listInvocations();
          const found = (list ?? []).find(r => r.invocationId === invocationId);
          if (!found) { sendResponse({ success: true, invocation: null }); return; }
          sendResponse({
            success: true,
            invocation: {
              invocationId   : found.invocationId,
              capabilityId   : found.capabilityId,
              capabilityName : found.capabilityName,
              debugMode      : found.debugMode,
              totalSteps     : found.progress?.total ?? 0,
              status         : found.status,
            },
          });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.38.0 (Pass K1) — debug control message handlers. Synchronous
    // setters on the invocation record; the running engine polls and
    // responds at its next yield-point.
    // v2.74.114 — All six sync handlers now wrap their body in try/catch.
    // Pre-fix, any throw inside the call (including the trivial case of
    // `payload` being null/undefined) skipped sendResponse entirely; the
    // channel closed with no response and the caller's ChatAPI promise
    // had to wait out the 60s timeout introduced in v2.74.112 to recover.
    // Now: a real error response is sent immediately on failure.
    case 'CAPABILITY_DEBUG_RESUME': {
      try {
        const ok = CapabilityAPI.debugResume(payload?.invocationId);
        sendResponse({ success: ok });
      } catch (err) {
        Logger.error('background', `CAPABILITY_DEBUG_RESUME failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }
    case 'CAPABILITY_DEBUG_STEP': {
      try {
        const ok = CapabilityAPI.debugStep(payload?.invocationId);
        sendResponse({ success: ok });
      } catch (err) {
        Logger.error('background', `CAPABILITY_DEBUG_STEP failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }
    case 'CAPABILITY_DEBUG_PAUSE': {
      try {
        const ok = CapabilityAPI.debugPause(payload?.invocationId);
        sendResponse({ success: ok });
      } catch (err) {
        Logger.error('background', `CAPABILITY_DEBUG_PAUSE failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }

    case 'CAPABILITY_GET_INVOCATION': {
      try {
        const snapshot = CapabilityAPI.getInvocation(payload?.invocationId);
        sendResponse({ success: true, invocation: snapshot });
      } catch (err) {
        Logger.error('background', `CAPABILITY_GET_INVOCATION failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }

    case 'CAPABILITY_LIST_INVOCATIONS': {
      try {
        const list = CapabilityAPI.listInvocations(payload ?? {});
        sendResponse({ success: true, invocations: list });
      } catch (err) {
        Logger.error('background', `CAPABILITY_LIST_INVOCATIONS failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }

    case 'CAPABILITY_CAPACITY': {
      try {
        const cap = CapabilityAPI.getCapacityStatus();
        sendResponse({ success: true, capacity: cap });
      } catch (err) {
        Logger.error('background', `CAPABILITY_CAPACITY failed: ${err.message}`);
        sendResponse({ success: false, error: err.message });
      }
      return false;
    }

    // v2.74.22 — APPROVE_STEP handler removed. AI-walked path is gone.

    // ── Template JSON edit (paste-and-save from UI) ───────────────────────────


    // (START_DISCOVERY + ABORT_DISCOVERY lived here until v2.74.952 — CR-X3b migrated the discovery
    // domain, with its abort-flag map + in-tab sitemap fetcher, to background/handlers/discovery.js.)

    case 'GET_SETTING': {
      const { key, defaultValue } = payload;
      chrome.storage.local.get(`settings:${key}`, (data) => {
        const val = data[`settings:${key}`];
        sendResponse({ value: val !== undefined ? val : defaultValue });
      });
      return true;
    }

    case 'SET_SETTING': {
      const { key, value } = payload;
      chrome.storage.local.set({ [`settings:${key}`]: value }, () => {
        Logger.info('background', `Setting saved: ${key} = ${JSON.stringify(value)}`);
        sendResponse({ success: true });
      });
      return true;
    }

    // ── Side panel mode switch ─────────────────────────────────────────────────
    // v2.27.0 — SET_PANEL_MODE removed. sidepanel.html no longer exists;
    // chat.html is the sole side-panel target. If something tries to send this
    // message it falls through to the default handler (unknown type warning).

    // ── API key ───────────────────────────────────────────────────────────────
    case 'SET_API_KEY':
      AnthropicService.saveApiKey(payload.key)
        .then(() => { Logger.info('background', 'API key updated'); sendResponse({ success: true }); })
        .catch(e => { Logger.error('background', `SET_API_KEY: ${e.message}`); sendResponse({ success: false, error: e.message }); });
      return true;

    case 'GET_API_KEY':
      AnthropicService.getApiKey()
        .then(key => sendResponse({ key: key ? '••••' + key.slice(-4) : null }))
        .catch(() => sendResponse({ key: null }));
      return true;

    case 'CHECK_API_KEY':
      // hasKey is true if ANY LLM transport works: managed proxy (cloud-enabled
      // + signed in) OR a local BYO key. Lets a no-key install pass UI guards
      // once signed into the cloud (C-P3 / DD-08).
      AnthropicService.hasLlm()
        .then(ok => sendResponse({ hasKey: !!ok }))
        .catch(() => sendResponse({ hasKey: false }));
      return true;

    // ── Orchard cloud (P0) ───────────────────────────────────────────────────
    case 'CLOUD_PING':
      sendResponse({ success: true, pong: true, ts: Date.now() });
      return false;

    case 'GET_STORAGE_PORT_META':
      sendResponse({ success: true, meta: getStoragePortMeta() });
      return false;

    case 'GET_CLOUD_SETTINGS':
      getCloudSettings()
        .then(settings => sendResponse({ success: true, settings }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;

    case 'SYNC_BRIDGE': {
      (async () => {
        try {
          const { kind, id, action = 'saved', groundId } = payload ?? message;
          await syncBridgeOnStorageChange(kind, id, action, { groundId });
          sendResponse({ success: true });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }

    case 'DELETE_LOCALE': {
      (async () => {
        try {
          const { groundId, localeKey } = payload ?? {};
          if (!groundId || !localeKey) {
            sendResponse({ success: false, error: 'groundId and localeKey required' });
            return;
          }
          await deleteRecordWithSync(
            'locale',
            localeKey,
            () => GroundAssetStore.deleteLocale(groundId, localeKey),
            groundId,
          );
          sendResponse({ success: true });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }

    case 'SET_CLOUD_SETTINGS':
      (async () => {
        try {
          const patch = { ...(payload.settings || {}) };
          if (patch.enabled === false) {
            patch.storageBackend = 'local';
          }
          await setCloudSettings(patch);
          await refreshStoragePort();
          const settings = await getCloudSettings();
          sendResponse({ success: true, settings });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;

    case 'GET_CLOUD_STATUS':
      getCloudAuthStatus()
        .then(async (status) => {
          /** @type {{ storageBackend: string, adapterKind: string }} */
          let meta = { storageBackend: 'local', adapterKind: 'chrome-storage' };
          try {
            meta = getStoragePortMeta();
          } catch { /* port not initialized yet */ }

          let pendingConflicts = 0;
          let outboxPending = 0;
          let workspacePartitionCount = 0;
          let lastSyncAt = 0;
          /** @type {Record<string, unknown>|null} */
          let lastSyncResult = null;
          try {
            pendingConflicts = (await getSyncConflicts()).length;
            outboxPending = await getOutboxCount();
            workspacePartitionCount = await getWorkspacePartitionCount();
            lastSyncAt = await getLastSyncAt();
            lastSyncResult = await getLastSyncResult();
          } catch (e) {
            Logger.warn('background', `GET_CLOUD_STATUS conflicts: ${e.message}`);
          }

          sendResponse({
            success: true,
            status: {
              ...status,
              storageBackend: meta.storageBackend,
              adapterKind: meta.adapterKind,
              pendingConflicts,
              outboxPending,
              workspacePartitionCount,
              lastSyncAt,
              lastSync: lastSyncResult,
            },
          });
        })
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;

    case 'CLOUD_SIGN_IN':
      signInToCloud()
        .then(async (result) => {
          if (result.success) {
            const settings = await getCloudSettings();
            if (settings.enabled) {
              await enableHybridSync();
              await refreshStoragePort();
              const syncRes = await runSync().catch(() => null);
              broadcastSyncApplied(syncRes?.applied);
            }
          }
          sendResponse({ success: result.success, ...result });
        })
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;

    case 'CLOUD_SIGN_OUT':
      signOutOfCloud()
        .then(async () => {
          await resetSyncBootstrap();
          await refreshStoragePort();
          sendResponse({ success: true });
        })
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;

    case 'CLOUD_GET_ME':
      getIdentityMe()
        .then(me => sendResponse({ success: true, me }))
        .catch(e => sendResponse({ success: false, error: e.message, status: e.status }));
      return true;

    case 'CLOUD_GET_OBJECT':
      getCloudObject(payload.path)
        .then(object => sendResponse({ success: true, object }))
        .catch(e => sendResponse({ success: false, error: e.message, status: e.status }));
      return true;

    case 'RUN_SYNC':
      ensureHybridSyncReady()
        .then(async (ready) => {
          if (!ready.ready) {
            sendResponse({ success: false, ok: false, error: ready.error });
            return;
          }
          await refreshStoragePort();
          const res = await runSync();
          broadcastSyncApplied(res.applied);
          sendResponse({ success: !!res.ok, ...res });
        })
        .catch(e => sendResponse({ success: false, ok: false, error: e.message }));
      return true;

    case 'FORCE_RESYNC_SITEMAP': {
      const groundId = payload?.groundId;
      if (!groundId) {
        sendResponse({ success: false, error: 'groundId required' });
        return true;
      }
      (async () => {
        try {
          const ready = await ensureHybridSyncReady();
          if (!ready.ready) {
            sendResponse({ success: false, error: ready.error });
            return;
          }
          const siteMap = await GroundAssetStore.readSiteMap(groundId);
          if (!siteMap) {
            sendResponse({ success: false, error: 'no local siteMap' });
            return;
          }
          const rec = GroundAssetStore.siteMapSyncRecord(groundId, {
            ...siteMap,
            updatedAt: Date.now(),
          });
          await forceResyncRecord('siteMap', rec);
          await refreshStoragePort();
          const res = await runSync();
          sendResponse({ success: !!res.ok, ...res });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }

    case 'GET_SYNC_CONFLICTS':
      getSyncConflicts()
        .then(conflicts => sendResponse({ success: true, conflicts }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;

    case 'RESOLVE_SYNC_CONFLICT':
      resolveSyncConflict(payload.path, payload.resolution)
        .then(result => sendResponse({ success: true, ...result }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;

    // ── Data ──────────────────────────────────────────────────────────────────


    case 'GET_LOGS':
      Logger.getPersistedLogs().then(entries => sendResponse({ entries })).catch(() => sendResponse({ entries: [] }));
      return true;

    case 'CLEAR_LOGS':
      Logger.clearLogs().then(() => { Logger.info('background', 'Logs cleared'); sendResponse({ success: true }); }).catch(() => sendResponse({ success: false }));
      return true;


    case 'GET_ALL_PROFILES':
      StorageManager.getAllProfiles().then(profiles => sendResponse({ profiles })).catch(() => sendResponse({ profiles: [] }));
      return true;

    case 'GET_PROMPTS':
      // v2.74.1710 — merge the LIVE modern-family prompts (sourced from Core/*Prompt.js builders, can't drift)
      // over the legacy hand-maintained snapshot, and hand Studio the catalog metadata so the new prompts render
      // without a second hardcoded registry to keep in sync.
      sendResponse({ prompts: { ...AnthropicService.getPromptTexts(), ...livePromptTexts() }, catalog: livePromptMeta() });
      return false;


    case 'LOG_ENTRY':
    case 'WALK_PROGRESS':
      return false;

    default:
      Logger.debug('background', `Unhandled: ${type}`);
      return false;
  }
});

// ── Profiling pass ────────────────────────────────────────────────────────────

/**
 * Runs the capability profiling pass on an already-open walk tab.
 * Executes N questions sequentially through the confirmed path, capturing
 * each response and building a structured capability profile progressively.
 *
 * Fires lazily after walk completion — background.js calls this without awaiting
 * so the user receives the "template ready" response immediately.
 *
 * @param {Object} options
 * @param {string} options.groundId
 * @param {string} options.groundUrl
 * @param {string} options.aiName
 * @param {number} options.tabId       - The open tab from the walk.
 * @param {Object} options.template    - The saved template with meta + anchors.
 */

Logger.info('background', 'Agent HUB service worker ready');
