/**
 * @file Services/Chat/tabTint.js
 * @description v2.74.1416 — active-tab background tint: the impure half.
 *
 * Captures the visible tab, downscales it to a thumbnail, hands the pixels to the
 * pure colour math in Core/tabTint.js, and writes the resulting hex tokens onto
 * :root as CSS custom properties. The panel's gradient then follows whatever site
 * the user is looking at.
 *
 * The panel also flips POLARITY with the page: a light site gives a light panel with
 * dark text, a dark site the reverse. That flip is a cut, never a fade — interpolating
 * one would drag background and foreground through mid-grey, where they meet at ~1:1.
 *
 * Three clocks drive it. Tab events (activate, navigate, focus) re-sample immediately.
 * A slow idle loop re-samples every SLOW_RESAMPLE_MS, so the panel tracks a page that
 * changes under its own power — a scroll, a video, a theme toggle. And a BREATH beat
 * every BREATH_MS advances a phase cursor across the sampled bands, re-tinting from the
 * cached palette WITHOUT a screenshot, so the gradient keeps moving even over a page
 * that never repaints. Every change is tweened rather than cut, and a deadband suppresses
 * tweens driven by JPEG noise instead of by the page.
 *
 * All of it yields to prefers-reduced-motion: under `reduce` the tint still tracks the
 * tab, but it lands instantly and never breathes.
 *
 * CSS cannot transition a linear-gradient, so the tween is done here: interpolate the
 * tokens, re-emit the gradient each frame. Core/tabTint.js#lerpTokens documents why
 * every intermediate frame still clears the contrast floor.
 *
 * Privacy: the screenshot never leaves this document. It is decoded, drawn into a
 * 32x32 OffscreenCanvas, reduced to four colours, and dropped. Nothing is persisted,
 * nothing reaches the network, and nothing reaches the LLM (cf. DESIGN_llm_privacy).
 *
 * Failure is always a revert, never a throw. Restricted pages (chrome://, the Web
 * Store, other extensions) cannot be captured at all, and a minimised or backgrounded
 * window will refuse too — in every such case the panel drops back to its static
 * stylesheet tokens rather than keeping a stale tint from the previous site.
 */

import { samplePalette, tintTokens, tintCss, lerpTokens, tokensClose, polarityFor } from '../../Core/tabTint.js';

/** Thumbnail edge, in pixels. 32x32 is ~1k pixels — plenty for a 4-colour reduction. */
const THUMB = 32;

/** Chrome throttles captureVisibleTab to ~2 calls/sec; stay clear of the ceiling. */
const MIN_CAPTURE_INTERVAL_MS = 900;

/** Coalesce the burst of events a single navigation emits. */
const DEBOUNCE_MS = 320;

/**
 * Idle re-sample cadence. The panel keeps breathing with the tab after navigation has
 * settled — a scroll, a playing video, a theme toggle all drift the gradient without any
 * event firing. Long on purpose: this is a repeated screenshot and should cost ~nothing.
 */
const SLOW_RESAMPLE_MS = 15000;

/**
 * Breath cadence, and how far the phase advances each beat. The panel re-tints from the
 * CACHED palette on this clock — no screenshot — so the gradient keeps moving between
 * the (expensive, rare) captures. At 0.5 band per beat over BAND_COUNT=5 bands, one full
 * cycle is 10 beats ≈ 50s: slow enough to notice only if you look for it.
 */
const BREATH_MS = 5000;
const PHASE_STEP = 0.5;

/**
 * Tween duration. Matched to BREATH_MS so each beat's ease-in-out lands exactly as the
 * next begins — the motion is continuous, with a gentle pulse at the seam. That pulse is
 * the point: a linear tween of the same length would read as a mechanical slide.
 */
const TWEEN_MS = 5000;

/** Per-channel deadband: below this, a re-sample is sensor noise, not a page change. */
const NOISE_TOLERANCE = 2;

const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

/**
 * An ambient, perpetually-moving background is exactly what this media query exists to
 * suppress — for vestibular disorders it is not decoration, it is a symptom trigger.
 *
 * Under `reduce` the tint still TRACKS the tab (a new site recolours the panel — that's a
 * state change, not an animation), but it lands instantly and never breathes on its own.
 */
const reduceMotionQuery = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;

const prefersReducedMotion = () => !!reduceMotionQuery?.matches;

const TOKEN_VARS = {
  bg: '--c-bg',
  bgElevated: '--c-bg-elevated',
  bgSubtle: '--c-bg-subtle',
  border: '--c-border',
  borderSoft: '--c-border-soft',
  scrollbar: '--c-scrollbar',
  text: '--c-text',
  textMuted: '--c-text-muted',
  textSubtle: '--c-text-subtle',
  accent: '--c-accent',
  accentHover: '--c-accent-hover',
  accentBg: '--c-accent-bg',
};

const GRADIENT_VAR = '--c-tint-gradient';

/**
 * Schemes captureVisibleTab can actually read. Everything else — chrome://, the Web
 * Store, other extensions, about:blank — throws. Checking up front lets us treat a
 * thrown capture as TRANSIENT (throttle, backgrounded window) and retry it, instead
 * of conflating "this page is unreadable" with "this attempt didn't land".
 */
const CAPTURABLE_SCHEME = /^(https?|file|ftp):/i;

/** One transient retry before we conclude the tint can't be produced and revert. */
const MAX_CONSECUTIVE_FAILURES = 2;

/**
 * Install the tint on the chat page. Idempotent per document.
 * @returns {{refresh: () => void, dispose: () => void}}
 */
export function installTabTint() {
  const root = document.documentElement;

  let canvas = null;
  let ctx = null;
  let windowId = null;

  let debounceTimer = 0;
  let idleTimer = 0;
  let breathTimer = 0;
  let rafId = 0;
  let phase = 0;           // breath cursor, in band units; never reset, so it resumes where it left off
  let palette = null;      // last good sample — the breath re-tints from this without re-capturing
  let polarity = 'dark';   // light or dark panel; fed back into polarityFor for hysteresis
  let lastCaptureAt = 0;
  let inFlight = 0;        // monotonic token — a stale capture must not overwrite a fresh one
  let failures = 0;        // consecutive transient capture failures; reset on any success
  let current = null;      // the tokens on screen right now (mid-tween, this is the frame)
  let target = null;       // the tokens we are tweening toward
  let lastPaintKey = '';   // rendered CSS of the last painted frame — skips no-op repaints
  let tinted = false;
  let disposed = false;

  // ── Paint ────────────────────────────────────────────────────────────────

  /**
   * Writing a custom property on :root invalidates style for every rule that reads it —
   * i.e. the whole panel. Across a slow tween most frames round to the SAME hex, so we
   * compare the rendered CSS and skip the DOM when nothing actually changed. A 2s drift
   * over a few units of colour ends up repainting a handful of times, not 120.
   */
  const paint = (tokens) => {
    const css = tintCss(tokens);
    const key = Object.keys(TOKEN_VARS).map((k) => css[k]).join('|') + `|${css.gradient}|${css.polarity}`;
    if (tinted && key === lastPaintKey) return;
    lastPaintKey = key;

    for (const [k, cssVar] of Object.entries(TOKEN_VARS)) root.style.setProperty(cssVar, css[k]);
    root.style.setProperty(GRADIENT_VAR, css.gradient);
    document.body.classList.add('tinted');
    document.body.classList.toggle('tinted-light', css.polarity === 'light');
    tinted = true;
  };

  /**
   * Drift from whatever is on screen to `next`. Re-targeting mid-tween starts from the
   * CURRENT interpolated frame, not from the old origin, so a tab switch during a drift
   * bends toward the new colour instead of snapping back and replaying.
   *
   * A hidden document parks rAF; on re-show the first callback sees a large elapsed time
   * and completes the tween in one frame. That snap is correct — nobody watched the drift.
   */
  const snapTo = (next) => {
    cancelAnimationFrame(rafId);
    rafId = 0;
    current = target = next;
    paint(next);
  };

  const tweenTo = (next) => {
    if (!current) { current = target = next; paint(next); return; }   // first tint: no fade-in from the default theme
    if (target && tokensClose(target, next, NOISE_TOLERANCE)) return; // already heading there

    // A polarity flip has no safe midpoint: background and foreground would cross through
    // mid-grey and meet at ~1:1. Cut, don't fade. (lerpTokens refuses to interpolate one
    // anyway — this just avoids spinning up an rAF that would paint a single frame.)
    if (current.polarity !== next.polarity) { snapTo(next); return; }

    // Track the tab, but don't animate toward it.
    if (prefersReducedMotion()) { snapTo(next); return; }

    cancelAnimationFrame(rafId);
    const from = current;
    target = next;
    const t0 = performance.now();

    const step = (now) => {
      if (disposed) return;
      // Reduced-motion toggled on mid-flight: land immediately rather than finish the drift.
      if (prefersReducedMotion()) { current = target = next; paint(next); rafId = 0; return; }
      const p = Math.min(1, (now - t0) / TWEEN_MS);
      current = lerpTokens(from, next, easeInOut(p));
      paint(current);
      if (p < 1) rafId = requestAnimationFrame(step);
      else { current = next; rafId = 0; }
    };
    rafId = requestAnimationFrame(step);
  };

  // Remove the inline overrides rather than writing the defaults back — the
  // stylesheet's own :root wins again, so the two can never drift apart.
  const revert = () => {
    cancelAnimationFrame(rafId);
    rafId = 0;
    current = target = null;
    palette = null;      // stop the breath: an unreadable page has no colours to keep pulsing
    polarity = 'dark';   // the stylesheet we fall back to IS dark — hysteresis must agree
    if (!tinted) return;
    for (const cssVar of Object.values(TOKEN_VARS)) root.style.removeProperty(cssVar);
    root.style.removeProperty(GRADIENT_VAR);
    document.body.classList.remove('tinted', 'tinted-light');
    lastPaintKey = '';
    tinted = false;
  };

  // ── Capture ──────────────────────────────────────────────────────────────

  const thumbnail = async (dataUrl) => {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    try {
      if (!canvas) {
        canvas = new OffscreenCanvas(THUMB, THUMB);
        ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'medium';
      }
      // Smoothed downscale averages each source region, so a colour's weight in the
      // thumbnail tracks the screen area it actually covers.
      ctx.drawImage(bitmap, 0, 0, THUMB, THUMB);
      return ctx.getImageData(0, 0, THUMB, THUMB);
    } finally {
      bitmap.close();
    }
  };

  const capture = async () => {
    if (disposed || document.hidden) return;

    if (windowId === null) windowId = (await chrome.windows.getCurrent()).id;

    const token = ++inFlight;
    lastCaptureAt = Date.now();

    // A page we can never read is not a failure to retry — it's a page with no colours
    // to borrow. Revert immediately: a stale tint would claim a colour this page never had.
    let tab;
    try { [tab] = await chrome.tabs.query({ active: true, windowId }); } catch { /* window gone */ }
    if (disposed || token !== inFlight) return;
    if (!tab || !CAPTURABLE_SCHEME.test(tab.url || '')) {
      failures = 0;
      revert();
      return;
    }

    let image;
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 40 });
      if (!dataUrl) throw new Error('empty capture');
      image = await thumbnail(dataUrl);
    } catch {
      // The page was readable, so this is transient: Chrome's ~2/sec throttle, a
      // backgrounded window, or the tab navigating mid-capture. Retry once before
      // giving up — reverting on the first blip would flicker the panel for nothing.
      if (token !== inFlight) return;
      if (++failures < MAX_CONSECUTIVE_FAILURES) schedule();
      else { revert(); failures = 0; }   // fresh retry budget for the next tab event
      return;
    }

    if (disposed || token !== inFlight) return;   // a newer capture already landed
    failures = 0;
    palette = samplePalette(image);

    // Hysteretic: pass the polarity we're already showing, so a page hovering near the
    // threshold can't flip the panel back and forth on successive samples.
    polarity = polarityFor(palette.dominant, polarity);
    tweenTo(tintTokens(palette, phase, polarity));   // re-tint at the CURRENT phase — a capture must not jerk the breath
  };

  /**
   * One beat. Costs no screenshot: it re-renders the cached palette at the next phase,
   * which is why the panel can keep breathing on a page that never repaints. Polarity is
   * held fixed here — only a fresh sample of the page may flip it.
   */
  const breathe = () => {
    if (disposed || document.hidden || !palette || prefersReducedMotion()) return;
    phase += PHASE_STEP;
    tweenTo(tintTokens(palette, phase, polarity));
  };

  const schedule = () => {
    if (disposed) return;
    clearTimeout(debounceTimer);
    const sinceLast = Date.now() - lastCaptureAt;
    const wait = Math.max(DEBOUNCE_MS, MIN_CAPTURE_INTERVAL_MS - sinceLast);
    debounceTimer = setTimeout(() => { void capture(); }, wait);
  };

  // ── Triggers ─────────────────────────────────────────────────────────────

  const isOurActiveTab = async (tabId) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      return tab.active && tab.windowId === windowId;
    } catch {
      return false;
    }
  };

  const onActivated = (info) => { if (info.windowId === windowId) schedule(); };

  // Re-sample on commit (the new site's colours are up) and again on complete
  // (late CSS/hero images have landed). The debounce collapses the pair when they're close.
  const onUpdated = (tabId, changeInfo) => {
    if (!changeInfo.status && !changeInfo.url) return;
    void isOurActiveTab(tabId).then((ours) => { if (ours) schedule(); });
  };

  const onFocusChanged = (id) => { if (id === windowId) schedule(); };
  const onVisibility = () => { if (!document.hidden) schedule(); };

  chrome.tabs.onActivated.addListener(onActivated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.windows.onFocusChanged.addListener(onFocusChanged);
  document.addEventListener('visibilitychange', onVisibility);

  // Two clocks. The slow one re-samples the tab (a screenshot); the fast one only re-renders
  // the cached palette at the next phase. capture() no-ops on a hidden document and breathe()
  // bails on one, so a backgrounded panel costs nothing on either clock.
  idleTimer = setInterval(schedule, SLOW_RESAMPLE_MS);
  breathTimer = setInterval(breathe, BREATH_MS);

  schedule();

  return {
    refresh: schedule,
    dispose() {
      disposed = true;
      clearTimeout(debounceTimer);
      clearInterval(idleTimer);
      clearInterval(breathTimer);
      cancelAnimationFrame(rafId);
      try { chrome.tabs.onActivated.removeListener(onActivated); } catch { /* */ }
      try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch { /* */ }
      try { chrome.windows.onFocusChanged.removeListener(onFocusChanged); } catch { /* */ }
      document.removeEventListener('visibilitychange', onVisibility);
      revert();
    },
  };
}
