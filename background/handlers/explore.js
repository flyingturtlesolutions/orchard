// background/handlers/explore.js — CR-X3a (v2.74.951): the EXPLORE domain, migrated whole from the
// background legacy switch (the ~400-line EXPLORE_PAGE_STRUCTURE banded poke-sweep) together with its
// state (the per-tab in-flight set, CR-U2). Registered beside the SG handlers; the dispatch, the
// `.catch` safety net, and _invokeSgHandler all apply unchanged. The handler body is byte-identical to
// the legacy case except: the case wrapper became a handler that RETURNS its promise chain, and the
// eight background-local helpers arrive via the asserted ctx seam (same pattern as sg.js).
//
// Logger tags stay 'background'/'explore'/'outcomes' DELIBERATELY — trace/`gl` continuity.

import { Logger }       from '../../Core/Logger.js';
import * as Locale      from '../../Core/locale.js';      // Locale builder (mergeDepthFromControls, deriveDisclosureGoals, ...)
import * as SiteMap     from '../../Core/siteMap.js';     // Ground siteMap contribution shapes
import * as ChromeHoist from '../../Core/chromeHoist.js'; // chrome-hoist skip-list for known chrome
import * as Outcomes    from '../../Core/outcomes.js';    // poke-reveal confirmation events
import { AnthropicService } from '../../Services/AnthropicService.js';  // band planner + affordance/goal synthesis
import { markEngineBusy, startHarvestSession, stopHarvestSession } from './sg.js';   // busy-mark; §17 — Explore-DEPTH ride-recipe harvest (poke-triggered API reads Discovery's breadth misses)

// v2.74.950-pattern (CR-X3a) — the explore ctx seam contract, asserted at wiring time.
const REQUIRED_CTX_KEYS = Object.freeze([
  'readLocaleCache', 'writeLocaleCache', 'normalizeUrl', 'readSiteMap', 'mergeSiteMapForGround',
  'readGroundChrome', 'deriveGroundChrome', 'appendOutcomes',
]);

/** Throw (at SW startup) if the seam object is missing any contract key. */
export function assertExploreCtx(ctx) {
  const missing = REQUIRED_CTX_KEYS.filter((k) => typeof ctx?.[k] !== 'function');
  if (missing.length) throw new Error(`createExploreHandlers: ctx is missing [${missing.join(', ')}]`);
  return ctx;
}

/**
 * @param {object} ctx  background-local helpers: { readLocaleCache, writeLocaleCache, normalizeUrl,
 *   readSiteMap, mergeSiteMapForGround, readGroundChrome, deriveGroundChrome, appendOutcomes }
 * @returns {Record<string, (payload:object, sender:object, sendResponse:Function) => Promise<void>>}
 */
export function createExploreHandlers(ctx) {
  assertExploreCtx(ctx);

  // v2.74.936 (CR-U2) — tabs with an EXPLORE sweep in flight (one per tab).
  const _exploreInFlight = new Set();

  return {
    EXPLORE_PAGE_STRUCTURE: (payload, _sender, sendResponse) => {
      let _ownsExplore = false;   // v2.74.936 (CR-U2) — only the invocation that ACQUIRED the flags releases them (a refused duplicate must not clear the live sweep's)
      return (async () => {
        let _harvestStarted = false, _harvestGround = null;   // §17 — Explore-DEPTH ride harvest: armed before the poke sweep, banked in the finally
        try {
          const { tabId, groundId = null, bandBudget = 8 } = payload ?? {};
          if (typeof tabId !== 'number') { sendResponse({ success: false, error: 'tabId required' }); return; }
          // v2.74.936 (CR-U2) — one sweep per tab: a full sweep can outlive the chat's 120s timeout, whose
          // "didn't finish" reply invited a SECOND "explore" that interleaved scrolls/pokes with the first
          // and double-wrote the Locale. A repeat ask gets an honest in-progress reply instead.
          if (_exploreInFlight.has(tabId)) { Logger.info('background', `EXPLORE ▸ already running on tab ${tabId} — second request refused`); sendResponse({ success: false, error: 'an explore is already running on this tab — it may take a couple of minutes; ask again when it finishes' }); return; }
          _exploreInFlight.add(tabId);
          _ownsExplore = true;
          markEngineBusy(tabId, true);   // v2.74.911 — the poke sweep's clicks must not be monitored as user interactions
          let _exploreCounts = null;   // v2.74.925 (CR-T2) — {featureCount, goalCount} once the Locale builds; the chat verb narrates them (the response's `structure` never carried features/goals — the .910 counts were silently null)
          let tabInfo;
          try { tabInfo = await chrome.tabs.get(tabId); }
          catch (e) { sendResponse({ success: false, error: `Tab not found: ${e.message}` }); return; }
          const url = tabInfo?.url ?? '';
          if (!/^https?:/i.test(url)) {
            sendResponse({ success: false, error: 'This page does not allow content scripts (chrome://, extension page, or restricted URL).' });
            return;
          }
          try { await chrome.scripting.executeScript({ target: { tabId }, files: ['ContentScripts/contentScript.js'] }); }
          catch (e) { Logger.warn('background', `EXPLORE_PAGE_STRUCTURE: inject failed (continuing): ${e.message}`); }

          const emitLog = (lines, tag) => { for (const ln of Array.isArray(lines) ? lines : []) Logger.info('explore', `[${tag}] ${ln}`); };
          // frameId:0 = TOP frame only (else sendMessage fans out to ad/about:blank iframes).
          const cs = (phasePayload) => chrome.tabs.sendMessage(tabId, { type: 'EXPLORE_PAGE_STRUCTURE', payload: phasePayload }, { frameId: 0 });

          // 1) metrics — scroll to the bottom (trigger lazy content), measure height.
          let metrics;
          try { metrics = await cs({ phase: 'metrics' }); }
          catch (e) { sendResponse({ success: false, error: `Page structure metrics failed: ${e.message}` }); return; }
          if (!metrics?.success) { sendResponse({ success: false, error: metrics?.error ?? 'metrics returned nothing' }); return; }
          emitLog(metrics.log, 'metrics');
          const vh = Number(metrics.viewportH) || 800;
          const scrollHeight = Number(metrics.scrollHeight) || vh;
          const title = metrics.title || '';
          const pageUrl = metrics.url || url;

          // v2.74.561 — DESTRUCTIVE-MUTATION SAFETY (Part 1): capture the read-only
          // substrate of the AS-LANDED state BEFORE the poke sweep perturbs the page.
          // The sweep is additive depth-discovery, but it can also DESTROY the entry
          // state — an SPA view-swap (a "Job description" ⇄ "Application form" toggle)
          // changes neither the URL nor fires beforeunload, so the in-page nav guard
          // can't see it and the page is captured on the WRONG view. Enumerating first
          // makes the user's deliberate state sacred: the form they navigated to is
          // captured no matter what poking does afterward. The sweep's revealed depth
          // is merged into THIS model below (mergeDepthFromControls).
          let enr = null;
          try { enr = await chrome.tabs.sendMessage(tabId, { type: 'ENUMERATE_PAGE' }, { frameId: 0 }); }
          catch (e) { Logger.warn('background', `pre-sweep ENUMERATE_PAGE failed (will retry post-sweep): ${e.message}`); }
          if (enr?.success) Logger.info('explore', `pre-sweep enumerate: ${(enr.features || []).length} feature(s) captured from entry state`);

          // EX-4 (Win C, v2.74.848) — FRESHNESS SHORT-CIRCUIT. The banded poke
          // sweep (per-band LLM plan + click+snapshot) and synthesizeGoals are the
          // entire cost of Explore; on a page we've already modeled that hasn't
          // materially changed, re-running all of it just reproduces the cached
          // Locale. The pre-sweep enumerate above is a cheap, deterministic content
          // fingerprint (feature ids are content hashes of kind|label|selector → a
          // real change detector, not a count). If it matches the cached Locale's
          // coverage.driftHash AND the cache is recent AND the cache is a real
          // Explore product (fidelity past L0 — never a shallow manual catalog),
          // return the cache and skip the sweep + goals entirely.
          if (groundId && enr?.success && Array.isArray(enr.features)) {
            try {
              const freshHash = Locale.driftHashFromRaw(enr.features);
              const freshKey  = ctx.normalizeUrl(enr.meta?.url ?? pageUrl);
              const cached    = await ctx.readLocaleCache(groundId, freshKey);
              const cm        = cached?.model || null;
              const cov       = cm?.coverage || {};
              const cachedAt  = Number(cached?.capturedAt ?? cov.lastExploredAt ?? 0);
              const ageMs     = Date.now() - cachedAt;
              const FRESH_TTL_MS = 12 * 60 * 60 * 1000;   // 12h — re-explored within the day ⇒ fresh
              const isExploreProduct = cov.fidelity && cov.fidelity !== 'L0';   // not a manual L0 catalog
              if (cm && cov.driftHash && cov.driftHash === freshHash && cachedAt > 0 && ageMs < FRESH_TTL_MS && isExploreProduct) {
                // Reconstruct lightweight reveal-controls from the cached model's
                // disclosure layers so the sidepanel chip reports the SAME depth the
                // prior sweep found ("N control(s) reveal hidden content") without
                // re-poking. Pure derivation from the cache.
                const synthControls = [];
                for (const f of Object.values(cm.features || {})) {
                  if (f?.kind === 'disclosure' && f.reveals) {
                    const layer = (cm.layers || {})[f.reveals];
                    const revCount = Array.isArray(layer?.features) ? layer.features.length : 0;
                    synthControls.push({ selector: f.selector, role: f.a11yRole || 'button', label: f.label || '', observation: 'reveal', revealCount: revCount, revealed: [] });
                  }
                }
                const reuseStructure = {
                  version: 1, url: cm.url || pageUrl, title: cm.title || title,
                  capturedAt: cachedAt, driftHash: cov.driftHash, fresh: true,
                  viewport: cm.viewport || { w: Number(metrics.viewportW) || tabInfo.width || 0, h: vh },
                  surface: [], controls: synthControls, planned: true,
                  ...(cm.affordances ? { affordances: cm.affordances } : {}),
                  stats: {
                    candidates: cov.featureCount ?? Object.keys(cm.features || {}).length,
                    controlsTried: synthControls.length, controlsRevealing: synthControls.length,
                    totalRevealed: synthControls.reduce((n, c) => n + c.revealCount, 0),
                    navAttempts: 0, bands: 0, aborted: null, freshSkip: true,
                  },
                };
                Logger.info('explore', `locale-fresh-skip: cached Locale matches current enumerate (driftHash ${freshHash}, age ${Math.round(ageMs / 60000)}m, ${Object.keys(cm.features || {}).length} feature(s), ${synthControls.length} disclosure(s)) — skipped poke sweep + goal synthesis`);
                sendResponse({ success: true, structure: reuseStructure, cacheKey: freshKey, fresh: true, featureCount: Object.keys(cm.features || {}).length, goalCount: Object.keys(cm.goals || {}).length });   // v2.74.925 (CR-T2) — counts for the chat explore narration
                return;
              }
            } catch (e) { Logger.warn('background', `locale-fresh-skip check failed (continuing with full sweep): ${e.message}`); }
          }

          // Band stops, BOTTOM-TO-TOP: from (scrollHeight - vh) up to 0.
          const step = Math.max(1, Math.round(vh * 0.85));
          const bandYs = [];
          for (let y = Math.max(0, scrollHeight - vh); y > 0; y -= step) bandYs.push(y);
          bandYs.push(0);   // always include the top band
          Logger.info('explore', `EXPLORE_PAGE_STRUCTURE: banded walk — height ${scrollHeight}, vh ${vh}, ${bandYs.length} band(s), bandBudget ${bandBudget}`);

          const seenCand = new Set();   // all enumerated selectors (for the count)
          const seenPoked = new Set();  // selectors already poked (cross-band dedup)
          const surfSeen = new Set();
          const allSurface = [];
          const allControls = [];
          let totalNav = 0, cid = 0, aborted = null;

          // v2.74.483 — Chrome-skip (GROUND_SPEC § 4): any chrome disclosure already promoted
          // (with its depth captured on a prior archetype) need not be RE-poked here. Seed
          // seenPoked with those selectors so the per-band planner never proposes them and the
          // poke skips them — saving an LLM plan call + a click+snapshot for every recurring
          // menu (the header account dropdown, mega-nav, etc.). The depth is grafted back after
          // the merge (graftChromeDepth) so the Locale still ends up self-contained.
          let groundChrome = null, chromeSkipped = 0;
          if (groundId) {
            try {
              groundChrome = await ctx.readGroundChrome(groundId);
              const cl = groundChrome?.chromeLayers || {};
              for (const base of Object.values(groundChrome?.chrome || {})) {
                if (base?.kind === 'disclosure' && base.reveals && cl[base.reveals] && base.selector && !seenPoked.has(base.selector)) {
                  seenPoked.add(base.selector); chromeSkipped++;
                }
              }
              if (chromeSkipped) Logger.info('explore', `chrome-skip: ${chromeSkipped} known chrome disclosure(s) won't be re-poked (depth grafted from Ground.chrome)`);
            } catch (e) { Logger.warn('background', `chrome-skip load failed (continuing): ${e.message}`); }
          }

          // v2.74.379 — Navigation recovery. A poked control can navigate via a
          // `location.href = …` assignment, which the in-page guard CANNOT
          // intercept. Detect it, go back to pageUrl, re-inject, and continue the
          // remaining bands (the navigator is already in seenPoked → not
          // re-poked). Capped to avoid nav loops eating the whole run.
          const norm = (u) => ctx.normalizeUrl(u || '');
          let recoveries = 0;
          const waitForTabLoad = async (timeoutMs = 8000) => {
            const t1 = Date.now();
            while (Date.now() - t1 < timeoutMs) {
              let info; try { info = await chrome.tabs.get(tabId); } catch { return false; }
              if (info && info.status === 'complete') return true;
              await new Promise(r => setTimeout(r, 200));
            }
            return true;
          };
          const ensureOnPage = async () => {
            let cur; try { cur = await chrome.tabs.get(tabId); } catch { return false; }
            if (norm(cur?.url) === norm(pageUrl)) return true;
            if (recoveries >= 3) { Logger.warn('explore', `recovery limit reached (stuck at ${cur?.url})`); return false; }
            recoveries++;
            Logger.warn('explore', `navigated away to ${cur?.url} — returning to ${pageUrl} (recovery ${recoveries}/3)`);
            try {
              await chrome.tabs.update(tabId, { url: pageUrl });
              await waitForTabLoad();
              await new Promise(r => setTimeout(r, 400));
              try { await chrome.scripting.executeScript({ target: { tabId }, files: ['ContentScripts/contentScript.js'] }); } catch { /* */ }
              return true;
            } catch (e) { Logger.warn('explore', `recovery failed: ${e.message}`); return false; }
          };

          // §17 (DESIGN_connectors.md) — ARM the body-blind harvest tee for the poke sweep. Clicking disclosures /
          // filters / "load more" fires INTERACTION-triggered API reads that Discovery's breadth crawl (one landing
          // load per archetype) never exercises — the depth class. Same-site + CONSENT-GATED; banked `pending` in the
          // finally (mergeRecipes dedups the overlap with Discovery). Best-effort; needs a resolved Ground + the store.
          if (groundId && typeof ctx.readRideRecipes === 'function' && typeof ctx.writeRideRecipes === 'function') {
            try {
              const _hh = new URL(pageUrl).host;
              const hr = await startHarvestSession({ groundId, host: _hh, appHost: _hh, origin: _hh, tabId });
              _harvestStarted = hr.ok; _harvestGround = groundId;
              if (hr.ok) Logger.info('ride', `explore harvest armed on ${_hh} (ground ${groundId})`);
            } catch (e) { Logger.warn('background', `explore harvest arm failed (continuing): ${e.message}`); }
          }

          for (const y of bandYs) {
            // Recover first if a prior poke navigated the tab away.
            if (!(await ensureOnPage())) { aborted = aborted || 'navigation-unrecovered'; break; }

            // a) content-script enumerates the candidates VISIBLE in this band.
            let band;
            try { band = await cs({ phase: 'band', scrollY: y }); }
            catch (e) { Logger.warn('background', `band y=${y} enumerate failed: ${e.message}`); continue; }
            if (!band?.success) continue;
            emitLog(band.log, 'band');
            for (const s of Array.isArray(band.surface) ? band.surface : []) {
              const k = `${s.role}|${s.label}|${s.rect?.x},${s.rect?.y}`;
              if (!surfSeen.has(k)) { surfSeen.add(k); if (allSurface.length < 400) allSurface.push(s); }
            }
            // Carry-forward: dedup on what's been POKED, not enumerated — a
            // candidate the planner skipped in an earlier (overlapping) band
            // reappears here and gets another chance when it's more central.
            for (const c of Array.isArray(band.candidates) ? band.candidates : []) { if (c?.selector) seenCand.add(c.selector); }
            const bandCands = (Array.isArray(band.candidates) ? band.candidates : []).filter(c => c?.selector && !seenPoked.has(c.selector));
            if (!bandCands.length) continue;

            // b) screenshot THIS band (matches the candidates exactly).
            let shot = null;
            if (tabInfo.active) {
              try { shot = await chrome.tabs.captureVisibleTab(tabInfo.windowId, { format: 'jpeg', quality: 55 }); }
              catch (e) { Logger.warn('background', `band y=${y} screenshot failed: ${e.message}`); }
            }
            // c) LLM plans which of THIS band's candidates to poke.
            let planSels = [];
            try {
              const planned = await AnthropicService.planPageExploration({ url: pageUrl, title, candidates: bandCands, screenshot: shot, maxPokes: bandBudget });
              if (planned && Array.isArray(planned.plan)) planSels = planned.plan;
            } catch (e) { Logger.warn('background', `band y=${y} planner failed: ${e.message}`); }
            planSels = planSels.filter(s => s && !seenPoked.has(s));
            for (const s of planSels) seenPoked.add(s);   // mark BEFORE poking → a navigator is never re-poked
            Logger.info('explore', `band y=${y}: ${bandCands.length} candidate(s) (poke-deduped), planned ${planSels.length}`);
            if (!planSels.length) continue;

            // d) content-script pokes ONLY the planned controls, verifying each.
            let pk = null;
            try { pk = await cs({ phase: 'poke', selectors: planSels, cidStart: cid }); }
            catch (e) { Logger.warn('background', `band y=${y} poke failed (likely navigation) — will recover next band: ${e.message}`); }
            if (pk?.success) {
              emitLog(pk.log, 'poke');
              for (const c of Array.isArray(pk.controls) ? pk.controls : []) allControls.push(c);
              cid += (pk.controls?.length || 0);
              totalNav += pk.navAttempts || 0;
              if (pk.aborted === 'navigation') Logger.warn('explore', `band y=${y}: a poke navigated — recovering on next band`);
            }
            // If pk failed, the frame likely navigated; ensureOnPage (next iter) recovers.
          }

          // Restore AFTER the loop (UNconditionally — bypasses the recovery cap):
          // a navigation in the LAST band has no "next band" to heal it, so
          // without this the user's tab is left on the navigated-to page.
          try {
            const cur = await chrome.tabs.get(tabId);
            if (norm(cur?.url) !== norm(pageUrl)) {
              Logger.warn('explore', `restoring tab to ${pageUrl} (was ${cur?.url})`);
              await chrome.tabs.update(tabId, { url: pageUrl });
              await waitForTabLoad();
              await new Promise(r => setTimeout(r, 400));
              try { await chrome.scripting.executeScript({ target: { tabId }, files: ['ContentScripts/contentScript.js'] }); } catch { /* */ }
            }
          } catch (e) { Logger.warn('explore', `final restore failed: ${e.message}`); }

          // cleanup — close any leftover overlay, scroll to top.
          try { const cl = await cs({ phase: 'cleanup' }); emitLog(cl?.log, 'cleanup'); }
          catch (e) { Logger.warn('background', `cleanup failed: ${e.message}`); }

          // Assemble the artifact from the per-band results.
          const controlsRevealing = allControls.filter(c => c?.observation === 'reveal').length;
          const totalRevealed = allControls.reduce((n, c) => n + (Number(c?.revealCount) || 0), 0);
          const fp = `${scrollHeight}#${seenCand.size}#${pageUrl}#` + allControls.map(c => `${c.role}:${(c.label || '').slice(0, 16)}`).sort().join('|');
          let hsh = 5381; for (let i = 0; i < fp.length; i++) hsh = ((hsh << 5) + hsh + fp.charCodeAt(i)) | 0;
          const structure = {
            version: 1, url: pageUrl, title, capturedAt: Date.now(), driftHash: (hsh >>> 0).toString(36),
            viewport: { w: Number(metrics.viewportW) || tabInfo.width || 0, h: vh },
            surface: allSurface, controls: allControls, planned: true,
            stats: { candidates: seenCand.size, controlsTried: allControls.length, controlsRevealing, totalRevealed, navAttempts: totalNav, bands: bandYs.length, aborted },
          };
          Logger.info('explore', `EXPLORE_PAGE_STRUCTURE done: ${bandYs.length} band(s), poked ${allControls.length}, revealed ${controlsRevealing}, navAttempts ${totalNav}${aborted ? `, aborted=${aborted}` : ''}`);

          // v2.74.393 — Page-affordance description (intent-independent "what
          // goals can be accomplished here"), cached on the artifact so the
          // grounded-intent step can reuse it without recomputing per intent.
          try {
            let affShot = null;
            if (tabInfo.active) { try { affShot = await chrome.tabs.captureVisibleTab(tabInfo.windowId, { format: 'jpeg', quality: 55 }); } catch { /* */ } }
            const affordances = await AnthropicService.describePageAffordances({ url: pageUrl, title, surface: allSurface, controls: allControls, screenshot: affShot });
            if (affordances) { structure.affordances = affordances; Logger.info('explore', `affordances described (${affordances.length} chars)`); }
          } catch (e) { Logger.warn('background', `describePageAffordances failed (continuing): ${e.message}`); }

          // v2.74.427 — #2 P5: pageStructure is no longer persisted as its own
          // artifact. The sweep's `structure` stays in-memory — folded into the
          // Locale below (mergeDepthFromControls) + returned for the sidepanel's
          // post-Explore chip; only the Locale is cached.
          const cacheKey = ctx.normalizeUrl(pageUrl);

          // v2.74.399 — Also build the Locale catalog (L0) from a read-only
          // enumerate pass, so the two artifacts stay in sync and Resolve's catalog
          // consumer (_knownSelectorsForUrl) has data without a separate manual
          // build. Best-effort; never fails the Explore response. The content
          // script is already injected (the sweep used it).
          try {
            // v2.74.561 — Prefer the PRE-sweep enumerate (entry state intact, captured
            // before any poke could swap the view). Only fall back to a fresh post-sweep
            // pass if the pre-sweep enumerate failed — never overwrite a good entry-state
            // capture with the (possibly perturbed) post-sweep DOM.
            if (!enr?.success) {
              try { enr = await chrome.tabs.sendMessage(tabId, { type: 'ENUMERATE_PAGE' }, { frameId: 0 }); }
              catch (e) { Logger.warn('background', `post-sweep ENUMERATE_PAGE fallback failed: ${e.message}`); }
            }
            if (enr?.success) {
              const model = Locale.buildLocale(enr.features, { ...enr.meta, groundId });   // G1-2 — bind the Locale to its Ground
              // v2.74.404 — L1 depth: merge THIS sweep's poke→reveal data (already
              // captured in `structure.controls`) into the model as Layers, so
              // disclosures (Explore / All images) become resolvable triggers — no
              // re-poking. The manual 🗂 catalog stays L0 (it never poked).
              try { Locale.mergeDepthFromControls(model, structure?.controls || []); }
              catch (e) { Logger.warn('background', `mergeDepthFromControls failed (continuing): ${e.message}`); }
              // v2.74.483 — graft the depth of any chrome disclosure we SKIPPED re-poking
              // above (chrome-skip), so this Locale ends up self-contained with the menu's
              // reveal layer + children — without the click+snapshot cost. No-op when nothing
              // was skipped or the trigger isn't present.
              if (groundChrome && chromeSkipped) {
                try { ChromeHoist.graftChromeDepth(model, groundChrome); }
                catch (e) { Logger.warn('background', `chrome depth graft failed (continuing): ${e.message}`); }
              }
              // v2.74.408 — L2: synthesize structured Goals from the catalog (LLM)
              // and attach them (feeds intent-grounding + perspective seeding). The
              // manual 🗂 catalog stays L0/L1 (no LLM goals call).
              try {
                const g = await AnthropicService.synthesizeGoals({ model, url: enr.meta?.url ?? pageUrl, title, affordances: structure.affordances });
                if (g?.goals?.length) Locale.attachGoals(model, g.goals);
              } catch (e) { Logger.warn('background', `synthesizeGoals failed (continuing): ${e.message}`); }
              // v2.74.637 — SG-0.5-F2: derive a goal PER disclosure-unit (PURE, no LLM) and merge it
              // alongside the LLM goals. synthesizeGoals lumps filter dropdowns (3-8 cap) and references
              // the triggers not the options; deriveDisclosureGoals walks reveals→layer to give Select/bind
              // a complete per-filter goal (Pay = dropdown + brackets + Update). Runs unconditionally so the
              // filter goals exist even if the LLM goals call failed. attachGoals merges (id = label+via).
              try { const dg = Locale.deriveDisclosureGoals(model); if (dg.length) Locale.attachGoals(model, dg); }
              catch (e) { Logger.warn('background', `deriveDisclosureGoals failed (continuing): ${e.message}`); }
              // v2.74.495 — derive within-Locale composites (search box / forms → `parts`) so the
              // partOf edge is real on the final feature set (post depth + goals). Best-effort.
              try { Locale.attachComposites(model); } catch (e) { Logger.warn('background', `attachComposites failed (continuing): ${e.message}`); }
              // v2.74.426 — #2 P1: the free-text affordance description lives ON the
              // Locale now (was only on pageStructure). Consumers read locale.affordances.
              if (structure.affordances) model.affordances = structure.affordances;
              // EX-5 (critic #4, v2.74.849) — score the Locale's trustworthiness for
              // authoring (pure, from coverage + structure.stats) and STAMP the tier on
              // coverage so it travels with the cached Locale. The auto-explore
              // orchestrator (EX-6) will gate on this; a MANUAL Explore never blocks
              // (the user asked for it) — here it's advisory: persist + warn.
              try {
                const trust = Locale.localeTrust(model, structure);
                model.coverage.trust = trust.tier;
                model.coverage.trustScore = trust.score;
                if (trust.tier === 'trusted') Logger.info('explore', `locale-trust: trusted (score ${trust.score}, ${trust.signals.featureCount} feature(s), ${trust.signals.goalCount} goal(s))`);
                else Logger.warn('explore', `locale-trust: ${trust.tier} (score ${trust.score}) — ${trust.reasons.map(r => r.code).join(', ')}`);
              } catch (e) { Logger.warn('background', `localeTrust failed (continuing): ${e.message}`); }
              const localeKey = ctx.normalizeUrl(enr.meta?.url ?? pageUrl);
              if (groundId) await ctx.writeLocaleCache(groundId, localeKey, { model, url: enr.meta?.url ?? pageUrl, capturedAt: model.coverage.lastExploredAt });
              // v2.74.431 — Ground siteMap (GROUND_SPEC § 7): merge this Locale's
              // contribution — a modeled node for this page + discovered nodes/edges
              // for every same-site nav destination it surfaced. One Explore sketches
              // the whole territory; a later Explore of a discovered page upgrades its
              // node modeled.
              if (groundId) {
                try {
                  // v2.74.438 — template through any persisted corpus rules (from sitemap
                  // ingestion) so this modeled node lands on the SAME archetype as the
                  // crawl/stub it upgrades.
                  const existingSm = await ctx.readSiteMap(groundId);
                  const rules = (existingSm && existingSm.templateRules) || [];
                  await ctx.mergeSiteMapForGround(groundId, SiteMap.siteMapFromLocale(model, { localeKey, rules }));
                } catch (e) { Logger.warn('background', `siteMap contribution failed (continuing): ${e.message}`); }
                // v2.74.481 — re-derive Ground.chrome now that one more Locale is modeled
                // (GROUND_SPEC § 4). Additive/non-destructive this slice. Never fails Explore.
                try { await ctx.deriveGroundChrome(groundId); }
                catch (e) { Logger.warn('background', `Ground.chrome derive failed (continuing): ${e.message}`); }
                await syncGroundAssetsAfterSave(groundId, {
                  localeKey,
                  siteMap: true,
                  chrome: !!(await ctx.readGroundChrome(groundId)),
                });
              }
              const layerCount = Object.keys(model.layers || {}).length - 1;   // minus the surface layer
              _exploreCounts = { featureCount: Object.keys(model.features).length, goalCount: Object.keys(model.goals || {}).length };   // v2.74.925 (CR-T2)
              Logger.info('explore', `Locale built alongside Explore: ${Object.keys(model.features).length} feature(s), ${Math.max(0, layerCount)} depth layer(s), ${Object.keys(model.goals || {}).length} goal(s), fidelity ${model.coverage.fidelity}`);

              // v2.74.417 — OUTCOMES: poke-reveal events (OUTCOMES_SPEC § 5). A
              // poke that REVEALED is a free, deterministic "this element IS a
              // disclosure" label — confirm the disclosure Feature's health and
              // bank a positive training pair. Only revealing pokes are emitted:
              // a control that (correctly) opens nothing must NOT log a poke-miss,
              // which foldFeatureHealth would count as a resolve-miss and decay a
              // perfectly healthy action button.
              try {
                if (groundId && model.features) {
                  const selToFid = new Map();
                  for (const f of Object.values(model.features)) if (f?.selector && f?.id && !selToFid.has(f.selector)) selToFid.set(f.selector, f.id);
                  const pokeEvents = [];
                  for (const c of structure?.controls || []) {
                    if (!c?.selector || c.observation !== 'reveal') continue;
                    const revealed = Array.isArray(c.revealed) ? c.revealed : [];
                    if (!revealed.length) continue;
                    pokeEvents.push(Outcomes.makeEvent({
                      phase: 'author', op: 'poke',
                      groundId, perspectiveId: enr.meta?.url ?? pageUrl,
                      featureId: selToFid.get(c.selector) ?? null,
                      input: { roleOrIntent: c.label || c.role || '' },
                      llmOutput: { selector: c.selector, operation: 'explore-poke' },
                      verdict: 'verified',
                      detail: { matchedCount: revealed.length, reason: c.overlay ? 'overlay-reveal' : 'inline-reveal' },
                    }));
                  }
                  if (pokeEvents.length) { await ctx.appendOutcomes(groundId, pokeEvents); Logger.info('outcomes', `explore poke-reveal → ${pokeEvents.length} disclosure confirmation(s)`); }
                }
              } catch (e) { Logger.warn('background', `poke-reveal outcomes emit failed (continuing): ${e.message}`); }
            }
          } catch (e) { Logger.warn('background', `Locale build during Explore failed (continuing): ${e.message}`); }

          sendResponse({ success: true, structure, cacheKey, ...(_exploreCounts || {}) });   // v2.74.925 (CR-T2)
        } catch (err) {
          Logger.error('background', `EXPLORE_PAGE_STRUCTURE failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        } finally {
          // §17 — STOP the harvest on EVERY exit (success / error / fresh-skip): unregister the tee, drain the tab's
          // accumulated poke-reads, bank them (generalize → polish → mergeRecipes, pending). _harvestStarted stays false
          // on the early returns (no Ground / fresh-skip / bad tab), so this is a clean no-op there.
          if (_harvestStarted && _harvestGround) {
            try {
              const sr = await stopHarvestSession({ groundId: _harvestGround, tabId: payload?.tabId, readRideRecipes: ctx.readRideRecipes, writeRideRecipes: ctx.writeRideRecipes });
              Logger.info('ride', `explore harvest: ${(sr.captures || []).length} capture(s) → banked ${sr.banked || 0} recipe(s) (ground ${_harvestGround})`);
            } catch (e) { Logger.warn('background', `explore harvest stop/bank failed: ${e.message}`); }
          }
        }
      })().finally(() => { if (_ownsExplore && typeof payload?.tabId === 'number') { markEngineBusy(payload.tabId, false); _exploreInFlight.delete(payload.tabId); } });   // v2.74.911; ownership-gated v2.74.936 (CR-U2)
    },
  };
}
