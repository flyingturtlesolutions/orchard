/**
 * @file Services/PageClassifier.js
 * @description Classify a precondition failure into a small enumerable
 *              category that implies a recovery path.
 *
 * v2.57.0 — Layered-recognizer abstraction.
 *
 * Each assertion-kind recognizer expresses category-specific evidence as
 * three layers, each with its own assertion and confidence band:
 *
 *   infrastructure — vendor domains, public APIs, infrastructure-set
 *                    cookies, page globals. Decays slowly (multi-year
 *                    cycles) because it's tied to product infrastructure.
 *
 *   structural     — DOM shape, frame inventory, meta tag conventions,
 *                    URL path patterns. Decays at medium rate.
 *
 *   presentational — text strings, class names, specific selectors.
 *                    Decays fast (every UI release).
 *
 * Confidence bands ('strong' | 'medium' | 'weak') are PER-RECOGNIZER. A
 * given layer's diagnostic value differs by category: Cloudflare detection
 * weights infrastructure 'strong'; login-wall detection (when added) would
 * weight presentational 'strong' because login walls aren't an infrastructure
 * category. The layer vocabulary is fixed; the weights are authored.
 *
 * Resolution: layers are evaluated in band order (strong, medium, weak).
 * The highest-band layer that fires determines the recognizer's confidence.
 * Lower-band layers don't add to confidence — they're fallbacks for when
 * stronger layers don't fire.
 *
 * Computed-kind recognizers (e.g. over_strict_precondition) are unchanged
 * from prior versions; the layered abstraction applies only to assertion
 * recognizers.
 *
 * Per-recognizer telemetry is logged through Logger.info on every classify()
 * call: which layers were evaluated, which fired, elapsed time, winning
 * layer. Console-only for now; future iteration can add persistence.
 *
 * @module Services/PageClassifier
 */

import { TemplateWalker }    from './TemplateWalker.js';
import { Logger }            from '../Core/Logger.js';
import { describeCondition } from './Assertion.js';
import { TelemetryStore }    from './TelemetryStore.js';

// ─── Confidence bands ─────────────────────────────────────────────────────

/**
 * Confidence band → numeric mapping. Bands abstract the calibration question
 * (what should "strong" actually be?) into three named values authors can
 * pick from. Numeric values here are starting points; tune from telemetry
 * once it accumulates.
 */
const CONFIDENCE_BY_BAND = Object.freeze({
  strong: 0.9,
  medium: 0.7,
  weak:   0.5,
});

/** Layer evaluation order — strong band first, weak band last. */
const LAYER_ORDER = Object.freeze(['infrastructure', 'structural', 'presentational']);

/** Internal: rank bands so we can compare strengths. Higher rank = stronger. */
const BAND_RANK = Object.freeze({ weak: 1, medium: 2, strong: 3 });

// ─── Type definitions ─────────────────────────────────────────────────────

/**
 * Classification result. Same external shape as v2.56.0 — downstream
 * consumers (PreconditionGate, ExecutionEngine, side panel) don't change.
 *
 * @typedef {Object} Classification
 * @property {string} category - Category name; 'unknown' if nothing matched.
 * @property {number} confidence - 0.0 to 1.0; meaningful for known categories.
 * @property {string[]} signalsFired - Human-readable descriptions of considered signals.
 * @property {number} signalsFiredCount - Count of signals known to have fired.
 * @property {number} totalSignals - Total signals considered for the winning layer.
 * @property {string} rationale - Short prose explanation of why the category fired.
 */

// ─── Recognizer definitions ──────────────────────────────────────────────
//
// Assertion-kind recognizers use the v2.57.0 layered schema:
//   {
//     kind: 'assertion_layered',
//     name: <category name>,
//     priority: <number, higher fires first>,
//     rationaleTemplate: <prose>,
//     layers: {
//       infrastructure?: { weight: 'strong'|'medium'|'weak', assertion: Assertion },
//       structural?:     { weight: 'strong'|'medium'|'weak', assertion: Assertion },
//       presentational?: { weight: 'strong'|'medium'|'weak', assertion: Assertion },
//     },
//   }
//
// Layers may be omitted if the category has no diagnostic signals at that
// level (e.g. login walls have no characteristic infrastructure).
//
// Computed-kind recognizers retain their v2.56.0 shape — see OVER_STRICT
// at the bottom.

/**
 * @example FIRES (real-world Indeed Cloudflare challenge):
 *   - performance.getEntriesByType('resource') includes
 *     "https://challenges.cloudflare.com/turnstile/..." and
 *     "/cdn-cgi/challenge-platform/..." → infrastructure layer fires
 *     via resource_loaded → recognizer fires with confidence 0.9.
 *
 * @example FIRES (hypothetical UI redesign that drops all current text):
 *   Even if "Additional Verification Required" is replaced with new copy
 *   and class names change, the infrastructure-layer signals
 *   (resource_loaded for vendor domains) remain stable. Recognizer still
 *   fires at full confidence.
 *
 * @example FIRES via fallback (older Cloudflare JS-challenge variant):
 *   No challenges.cloudflare.com resource (no Turnstile), but URL contains
 *   /cdn-cgi/challenge → structural layer fires → confidence 0.7.
 */
const CLOUDFLARE_CHALLENGE = {
  kind: 'assertion_layered',
  name: 'cloudflare_challenge',
  priority: 100,
  rationaleTemplate: 'Cloudflare challenge detected — site is presenting an automated-traffic verification.',
  layers: {
    infrastructure: {
      weight: 'strong',
      assertion: {
        match: 'any',
        conditions: [
          // Strongest: page actually fetched Cloudflare challenge resources.
          // Decays only if Cloudflare reorganizes their public CDN paths.
          { type: 'resource_loaded', pattern: 'challenges\\.cloudflare\\.com' },
          { type: 'resource_loaded', pattern: '/cdn-cgi/challenge-platform/' },
          // Cookies set by Cloudflare's bot management. cf_clearance is
          // typically not HttpOnly (visible to document.cookie); __cf_bm
          // often IS HttpOnly (invisible). Best-effort fallback signal.
          { type: 'cookie_present', name: 'cf_clearance' },
          { type: 'cookie_present', name: '__cf_bm' },
        ],
      },
    },
    structural: {
      weight: 'medium',
      assertion: {
        match: 'any',
        conditions: [
          // Older Cloudflare challenge variants serve at this URL pattern.
          { type: 'url_matches', pattern: '/cdn-cgi/(challenge|l/chk_jschl)' },
          // Cloudflare challenge convention: auto-refresh meta tag with
          // a numeric interval (typically 360 seconds). Normal pages
          // rarely set this.
          { type: 'meta_equals', httpEquiv: 'refresh', valuePattern: '^\\d+' },
        ],
      },
    },
    presentational: {
      weight: 'weak',
      assertion: {
        match: 'k_of_n',
        count: 2,
        conditions: [
          // Light-DOM script-tag presence. These age moderately — Cloudflare
          // could rename the script paths during a CDN reorganization but
          // it's not on every release. Demoted from "infrastructure" in
          // v2.55.0 because they're really presentational signals that
          // happen to be queryable; the actual infrastructure check is
          // resource_loaded which sees what the browser fetched.
          { type: 'selector_present', selector: 'script[src*="/cdn-cgi/challenge-platform/"]' },
          { type: 'selector_present', selector: 'script[src*="challenges.cloudflare.com"]' },
          // Text patterns. Decay fastest — A/B tests, localization,
          // brand redesigns all break these.
          { type: 'text_present', text: 'Additional Verification Required' },
          { type: 'text_present', text: 'Verify you are human' },
          { type: 'text_present', text: 'Checking your browser' },
        ],
      },
    },
  },
};

/**
 * @example FIRES via infrastructure (page loaded hCaptcha/reCAPTCHA resources):
 *   - resource_loaded for hcaptcha.com or google.com/recaptcha → strong (0.9).
 *
 * @example FIRES via presentational (fallback when vendor URLs change):
 *   - Two text patterns match → weak (0.5). Better than nothing; user
 *     gets recovery hint even if the recognizer is uncertain.
 *
 * @note No structural layer for this recognizer. CAPTCHA pages don't have
 *       a characteristic URL path (the CAPTCHA appears mid-flow on whatever
 *       URL the site was on) and don't have a vendor-specific meta convention.
 *       Omitting a layer is fine in the schema.
 */
const CAPTCHA_BLOCKER = {
  kind: 'assertion_layered',
  name: 'captcha_blocker',
  priority: 90,
  rationaleTemplate: 'CAPTCHA challenge detected — site is requiring human verification before allowing access.',
  layers: {
    infrastructure: {
      weight: 'strong',
      assertion: {
        match: 'any',
        conditions: [
          // hCaptcha resources.
          { type: 'resource_loaded', pattern: 'hcaptcha\\.com' },
          // reCAPTCHA resources (Google serves from multiple paths).
          { type: 'resource_loaded', pattern: 'google\\.com/recaptcha' },
          { type: 'resource_loaded', pattern: 'gstatic\\.com/recaptcha' },
          { type: 'resource_loaded', pattern: 'www\\.google\\.com/recaptcha' },
        ],
      },
    },
    presentational: {
      weight: 'weak',
      assertion: {
        match: 'k_of_n',
        count: 2,
        conditions: [
          { type: 'selector_present', selector: 'iframe[src*="hcaptcha.com"]' },
          { type: 'selector_present', selector: 'iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"]' },
          { type: 'selector_present', selector: '.h-captcha, .g-recaptcha' },
          { type: 'text_present', text: "I'm not a robot" },
          { type: 'text_present', text: 'verify you are human' },
        ],
      },
    },
  },
};

// ─── Computed recognizer (unchanged structure from v2.56) ─────────────────

/**
 * Computed recognizer: detects when a fragment's URL precondition is
 * over-strict — the regex doesn't tolerate query strings or hash fragments
 * that the actual URL has.
 *
 * Conservative: only fires when EXACTLY ONE precondition failed and it's
 * a url_matches that would pass if the actual URL were stripped of query
 * and hash.
 *
 * @param {number} _tabId - unused
 * @param {Object} _fragment - unused
 * @param {Object[]} failures
 * @param {string} actualUrl
 * @returns {Classification|null}
 */
function evaluateOverStrictPrecondition(_tabId, _fragment, failures, actualUrl) {
  if (!Array.isArray(failures) || failures.length !== 1) return null;
  if (!actualUrl) return null;

  const failure = failures[0];
  const cond = failure?.condition;
  if (cond?.type !== 'url_matches' || !cond.pattern) return null;

  let regex;
  try { regex = new RegExp(cond.pattern); } catch { return null; }
  if (regex.test(actualUrl)) return null;

  let stripped;
  try {
    const u = new URL(actualUrl);
    stripped = `${u.protocol}//${u.host}${u.pathname}`;
  } catch { return null; }

  if (!regex.test(stripped)) return null;

  const tail = actualUrl.replace(stripped, '');
  return {
    category: 'over_strict_precondition',
    confidence: 0.9,
    signalsFired: [
      `URL precondition (${cond.pattern}) does not tolerate the URL tail`,
      'Actual URL minus query/hash matches the precondition',
    ],
    signalsFiredCount: 2,
    totalSignals: 2,
    rationale: `URL precondition is too strict — it doesn't tolerate query parameters or hash fragments. Actual URL has tail "${tail}" that the pattern rejects, but the rest of the URL matches. Relaxing the pattern (e.g. appending "(?:[?#].*)?") would let this fragment run.`,
  };
}

const OVER_STRICT_PRECONDITION = {
  kind: 'computed',
  name: 'over_strict_precondition',
  priority: 50,
  evaluate: evaluateOverStrictPrecondition,
};

// Sort once at module load — recognizers are static.
const SORTED_RECOGNIZERS = [
  CLOUDFLARE_CHALLENGE,
  CAPTCHA_BLOCKER,
  OVER_STRICT_PRECONDITION,
].sort((a, b) => b.priority - a.priority);

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Construct an "unknown" classification.
 *
 * @param {string} [rationale]
 * @returns {Classification}
 */
function unknownClassification(rationale = 'No known failure category matched. The page state is something the classifier does not recognize.') {
  return {
    category: 'unknown',
    confidence: 0,
    signalsFired: [],
    signalsFiredCount: 0,
    totalSignals: 0,
    rationale,
  };
}

/**
 * Evaluate one layer of a layered recognizer against the live page.
 * Returns { fired: bool, elapsed_ms: number, signalsConsidered: string[] }.
 *
 * @param {Object} layer - { weight, assertion }
 * @param {number} tabId
 * @returns {Promise<{fired: boolean, elapsedMs: number, signalsConsidered: string[]}>}
 */
async function evaluateLayer(layer, tabId) {
  const t0 = Date.now();
  const probe = await TemplateWalker.checkConditions({
    tabId,
    conditions: layer.assertion,
  });
  const elapsedMs = Date.now() - t0;
  const signalsConsidered = (layer.assertion.conditions ?? []).map(describeCondition);
  return { fired: probe.ok, elapsedMs, signalsConsidered };
}

/**
 * Evaluate a layered-assertion recognizer. Walks layers from strongest to
 * weakest; first layer that fires determines the classification. Logs a
 * per-layer telemetry line through Logger.info for observability.
 *
 * Returns both the Classification (or null on miss) AND a per-recognizer
 * trace record suitable for storage in TelemetryStore. The trace records
 * which layers were evaluated, their weights, fire/miss outcome, and
 * elapsed times — enough to compute fire rates and average evaluation
 * costs per (recognizer, layer) over time.
 *
 * @param {Object} recognizer - layered recognizer
 * @param {number} tabId
 * @returns {Promise<{classification: Classification|null, recognizerRecord: Object}>}
 */
async function evaluateLayeredRecognizer(recognizer, tabId) {
  const { name, layers, rationaleTemplate } = recognizer;
  const tStart = Date.now();

  // Build evaluation order: present layers, ordered by band rank descending,
  // then by canonical layer order for stable iteration when bands tie.
  const layersToEval = LAYER_ORDER
    .filter(layerName => layers[layerName])
    .map(layerName => ({ layerName, ...layers[layerName] }))
    .sort((a, b) => (BAND_RANK[b.weight] ?? 0) - (BAND_RANK[a.weight] ?? 0));

  const trace = []; // per-layer outcomes for telemetry

  for (const { layerName, weight, assertion } of layersToEval) {
    const { fired, elapsedMs, signalsConsidered } = await evaluateLayer(
      { weight, assertion }, tabId,
    );
    trace.push({ name: layerName, weight, fired, elapsedMs, signalCount: signalsConsidered.length });

    if (fired) {
      // Telemetry: per-layer outcomes plus the winning summary.
      Logger.info('PageClassifier',
        `${name} fired via layer=${layerName} weight=${weight} elapsed_ms=${elapsedMs} ` +
        `trace=[${trace.map(t => `${t.name}:${t.weight}:${t.fired ? 'fired' : 'miss'}:${t.elapsedMs}ms`).join(', ')}]`);

      const confidence = CONFIDENCE_BY_BAND[weight] ?? 0.5;
      const k = (assertion.match === 'k_of_n' && Number.isInteger(assertion.count))
        ? assertion.count : 1;
      const n = signalsConsidered.length;
      const classification = {
        category: name,
        confidence,
        signalsFired: signalsConsidered,
        signalsFiredCount: assertion.match === 'any' ? 1 : k,
        totalSignals: n,
        rationale: `${rationaleTemplate} Fired via ${layerName} layer (${weight} confidence). At least ${assertion.match === 'any' ? 1 : k} of ${n} signals matched.`,
      };
      const recognizerRecord = {
        name, kind: 'assertion_layered',
        fired: true,
        elapsedMs: Date.now() - tStart,
        layers: trace,
      };
      return { classification, recognizerRecord };
    }
  }

  // No layer fired. Log the full miss trace so we can see which layers
  // were considered and how long each took.
  Logger.info('PageClassifier',
    `${name} did not fire. trace=[${trace.map(t => `${t.name}:${t.weight}:miss:${t.elapsedMs}ms`).join(', ')}]`);
  return {
    classification: null,
    recognizerRecord: {
      name, kind: 'assertion_layered',
      fired: false,
      elapsedMs: Date.now() - tStart,
      layers: trace,
    },
  };
}

/**
 * Classify a precondition failure.
 *
 * Iterates recognizers in priority order. First match wins. Returns the
 * canonical 'unknown' classification if nothing matches. Never throws.
 *
 * Builds a ClassificationEvent recording every recognizer that was
 * evaluated (whether it fired or not, with per-layer trace data) and
 * persists it via TelemetryStore. Telemetry write is wrapped — failures
 * do not affect the returned classification.
 *
 * @param {Object} args
 * @param {number} args.tabId
 * @param {Object} args.fragment
 * @param {Object[]} args.preconditionFailures
 * @param {string|null} args.actualUrl
 * @returns {Promise<Classification>}
 */
async function classify({ tabId, fragment, preconditionFailures, actualUrl }) {
  const tStart = Date.now();
  const recognizerRecords = [];   // accumulator for telemetry event
  let winningClassification = null;

  for (const recognizer of SORTED_RECOGNIZERS) {
    try {
      if (recognizer.kind === 'assertion_layered') {
        const { classification, recognizerRecord } =
          await evaluateLayeredRecognizer(recognizer, tabId);
        recognizerRecords.push(recognizerRecord);
        if (classification) {
          winningClassification = classification;
          break;
        }
      } else if (recognizer.kind === 'computed') {
        const tRecStart = Date.now();
        const result = recognizer.evaluate(tabId, fragment, preconditionFailures, actualUrl);
        recognizerRecords.push({
          name: recognizer.name,
          kind: 'computed',
          fired: !!result,
          elapsedMs: Date.now() - tRecStart,
        });
        if (result) {
          Logger.info('PageClassifier',
            `${recognizer.name} (computed) fired confidence=${result.confidence}`);
          winningClassification = result;
          break;
        }
      }
    } catch (err) {
      Logger.warn('PageClassifier', `Recognizer ${recognizer.name} threw: ${err.message}`);
      // Record the throw as a non-fire so the telemetry event still has
      // a complete recognizer list. We don't have layer data on a throw.
      recognizerRecords.push({
        name: recognizer.name,
        kind: recognizer.kind ?? 'unknown',
        fired: false,
        threw: true,
        error: err.message,
      });
    }
  }

  const totalElapsedMs = Date.now() - tStart;
  const result = winningClassification ?? unknownClassification();

  // Build and persist the telemetry event. Wrapped so any storage error
  // is logged but does not affect the returned classification.
  const event = buildEvent({
    fragment, actualUrl, classification: result,
    recognizers: recognizerRecords, totalElapsedMs,
  });
  try {
    // Fire-and-forget: we don't await, so classify() returns immediately
    // and the storage write proceeds in the background. PageClassifier
    // returns to its caller without telemetry on the critical path.
    // .catch handles any async rejection — TelemetryStore.record has its
    // own internal try/catch but defense-in-depth.
    TelemetryStore.record(event).catch(err =>
      Logger.warn('PageClassifier', `TelemetryStore.record rejected: ${err.message}`));
  } catch (err) {
    Logger.warn('PageClassifier', `TelemetryStore.record threw: ${err.message}`);
  }

  Logger.info('PageClassifier',
    `classify result=${result.category} confidence=${result.confidence} ` +
    `recognizers_evaluated=${recognizerRecords.length} total_elapsed_ms=${totalElapsedMs}`);

  return result;
}

/**
 * Build a ClassificationEvent for storage. Pure data transformation — no
 * side effects. Origin is extracted from the actual URL; full URL is NOT
 * stored (paths and query strings can be sensitive).
 *
 * @returns {Object}
 */
function buildEvent({ fragment, actualUrl, classification, recognizers, totalElapsedMs }) {
  let origin = null;
  if (actualUrl) {
    try { origin = new URL(actualUrl).origin; } catch { /* drop on parse failure */ }
  }
  return {
    timestamp: Date.now(),
    fragmentId: fragment?.id ?? null,
    origin,
    classification: classification.category,
    confidence: classification.confidence,
    recognizers,
    totalElapsedMs,
  };
}

/**
 * Get a one-line summary of a classification suitable for log output.
 *
 * @param {Classification} c
 * @returns {string}
 */
function summarize(c) {
  if (!c || c.category === 'unknown') return 'unknown';
  const conf = (c.confidence * 100).toFixed(0);
  return `${c.category} (${conf}% confidence, >=${c.signalsFiredCount}/${c.totalSignals} signals)`;
}

/**
 * Inspection helpers — call from the service worker DevTools console:
 *
 *   await PageClassifier.dumpTelemetry()
 *     → returns aggregation summary (per-recognizer fire rates,
 *       per-layer fire rates, recent events).
 *
 *   await PageClassifier.clearTelemetry()
 *     → drops all stored events. Useful between observation periods.
 *
 *   await PageClassifier.rawTelemetry()
 *     → returns the raw event buffer for ad-hoc inspection.
 */
async function dumpTelemetry()  { return await TelemetryStore.aggregate(); }
async function clearTelemetry() { return await TelemetryStore.clear(); }
async function rawTelemetry()   { return await TelemetryStore.getRawEvents(); }

export const PageClassifier = {
  classify, summarize, unknownClassification,
  dumpTelemetry, clearTelemetry, rawTelemetry,
};
