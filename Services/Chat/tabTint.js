/**
 * @file Services/Chat/tabTint.js
 * @description v2.74.1433 — active-tab background tint: the impure half.
 *
 * Captures the visible tab, downscales it to a thumbnail, hands the pixels to the
 * pure colour math in Core/tabTint.js, and writes the resulting hex tokens onto
 * :root as CSS custom properties. The panel's gradient tracks whatever is ON SCREEN
 * in the tab — including as the user scrolls, since scrolling changes the visible
 * colour scheme just as surely as navigating does.
 *
 * THE MODEL IS A FOLLOWER, NOT A SEQUENCE OF TWEENS. A `target` is recomputed every
 * frame from the latest sample and the breath phase; `current` chases it by exponential
 * approach (FOLLOW_TAU_MS). So the panel is always in transition and never restarts:
 * a fresh sample bends the motion rather than interrupting it. An eased tween cannot do
 * this — retargeting one resets its velocity to zero, which reads as a stutter precisely
 * when samples arrive most often.
 *
 * Three inputs move the target:
 *   - CAPTURE, every SAMPLE_MS (and on tab activate/navigate/focus). This is the only
 *     expensive one; Chrome throttles captureVisibleTab to ~2/sec, so it stays under that.
 *   - BREATH, a phase cursor advancing continuously across the sampled regions, so the
 *     gradient keeps drifting over a page that never repaints.
 *   - POLARITY, when the page crosses light/dark. That one is NOT followed, and cannot be:
 *     surfaces and foreground must cross together at the contrast crossover, and half the
 *     crossing sits below AAA. So it is a brief crossfade of the SCHEME ONLY — the colours
 *     already on screen, re-rendered at the new polarity — after which the follower carries
 *     the colour distance at its usual pace. A light-to-dark tab switch therefore reads as
 *     a quick scheme change followed by a long drift, never as a minute in the trough.
 *
 * All of it yields to prefers-reduced-motion: under `reduce` the tint still tracks the
 * tab, but it lands instantly, never breathes, and runs no animation frames at all.
 *
 * CSS cannot transition a linear-gradient, so the interpolation is done here: blend the
 * tokens, re-emit the gradient each frame. Core/tabTint.js#lerpTokens documents why every
 * intermediate frame still clears the contrast floor.
 *
 * Privacy: the screenshot never leaves this document. It is decoded, drawn into a
 * 32x32 OffscreenCanvas, reduced to a handful of colours, and dropped. Nothing is
 * persisted, nothing reaches the network, nothing reaches the LLM (cf. DESIGN_llm_privacy).
 *
 * Failure is always a revert, never a throw. Restricted pages (chrome://, the Web
 * Store, other extensions) cannot be captured at all, and a minimised or backgrounded
 * window will refuse too — in every such case the panel drops back to its static
 * stylesheet tokens rather than keeping a stale tint from the previous site.
 */

import { samplePalette, tintTokens, tintCss, lerpTokens, flipTokens, polarityFor, REGION_COUNT } from '../../Core/tabTint.js';

/** Thumbnail edge, in pixels. 32x32 is ~1k pixels — plenty for a small colour reduction. */
const THUMB = 32;

/**
 * Capture cadence. Chrome throttles captureVisibleTab to ~2 calls/sec and throws past it,
 * so 1/sec leaves headroom for the event-driven captures to interleave without tripping it.
 * This is what makes SCROLL track: nothing else tells us the viewport's colours moved.
 */
const SAMPLE_MS = 1000;

/** Floor between any two captures, however they were triggered. Keeps us under the quota. */
const MIN_CAPTURE_INTERVAL_MS = 900;

/** Coalesce the burst of events a single navigation emits. */
const DEBOUNCE_MS = 320;

/**
 * How long a full colour change takes to land — a tab switch, or a scroll into a
 * differently coloured section. Exponential approach never formally arrives, so "settled"
 * means three time constants: 95% of the distance closed.
 *
 * Frame-rate independent by construction (see the exp(-dt/tau) in tick), so it behaves the
 * same on a 60Hz and a 144Hz display, and survives a frame budget it misses.
 */
const FOLLOW_SETTLE_MS = 66000;
const FOLLOW_TAU_MS = FOLLOW_SETTLE_MS / 3;   // 63% closed at 22s, 95% at 66s

/*
 * 66s, not 60: a flip's bridge starts nearer the target than a cold start does, so an exact
 * 60s constant let the fastest case (black -> white) land at 57s. Measured settle across
 * the corners is now 63s .. 87s, i.e. never under the minute.
 */

/**
 * One full sweep of the breath across all regions.
 *
 * Coupled to FOLLOW_TAU_MS, not freely chosen. The follower is a first-order low-pass
 * filter, so it attenuates the breath by 1/sqrt(1 + (2*pi*tau/period)^2). At the old 60s
 * period against a 22s tau that keeps only ~40% of the swing — the breath would be eaten by
 * the very slowness that makes a tab switch gentle. 180s keeps 79%.
 */
const BREATH_PERIOD_MS = 180000;

/**
 * A hidden document parks rAF; on re-show the first frame reports the whole gap as dt.
 * Clamping it stops the panel snapping (and the phase jumping) after a spell in the
 * background — it just resumes following from where it was.
 */
const MAX_FRAME_DT_MS = 100;

/**
 * Polarity crossfade duration. Short, and it must STAY short however slow the follower
 * gets: a flip spends 49.5% of its span below 7:1 and 16.9% below 4.5:1 (measured over
 * flipTokens; the trough at the crossover bottoms out near 3.5:1). At 1200ms that is at
 * most 0.59s under AAA and 0.20s under AA — and less in practice, since the bridge below
 * crosses a shorter colour distance (measured 0.28s / 0.27s black->white). Stretched to
 * FOLLOW_SETTLE_MS it would be ~30s and ~10s: a minute of barely-legible panel.
 *
 * So a polarity flip is NOT slowed down. It is decoupled instead: `adopt` crossfades only
 * the SCHEME (old colours, new polarity) at this speed, then hands the panel to the
 * follower, which carries the colour distance over FOLLOW_SETTLE_MS like any other change.
 */
const FLIP_MS = 1200;

/*
 * No noise deadband here any more, and deliberately so. The discrete-tween model needed
 * one: a ±2-unit JPEG wobble would kick off a fresh tween on every idle re-sample. The
 * follower doesn't — a target jittering by two units is attenuated to nothing by a 22s
 * time constant, and paint() skips the DOM when the rounded hex is unchanged. Keeping a
 * deadband would also have been a BUG: it short-circuited before polarityFor ran, so a
 * page darkening past the threshold in sub-tolerance steps would never have flipped.
 */

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
  railBg: '--c-rail-bg',
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
  let sampleTimer = 0;
  let rafId = 0;
  let lastFrameAt = 0;

  let phase = 0;           // breath cursor, in region units; never reset, so it resumes where it left off
  let palette = null;      // last good sample — the follower re-tints from this without re-capturing
  let polarity = 'dark';   // light or dark panel; fed back into polarityFor for hysteresis
  let flipping = false;    // a polarity crossfade owns the panel until it lands

  let lastCaptureAt = 0;
  let inFlight = 0;        // monotonic token — a stale capture must not overwrite a fresh one
  let failures = 0;        // consecutive transient capture failures; reset on any success

  let current = null;      // the tokens on screen right now
  let lastPaintKey = '';   // rendered CSS of the last painted frame — skips no-op repaints
  let tinted = false;
  let disposed = false;

  // ── Paint ────────────────────────────────────────────────────────────────

  /**
   * Writing a custom property on :root invalidates style for every rule that reads it —
   * i.e. the whole panel. The follower moves in fractions of a colour step, so most frames
   * round to the SAME hex; comparing the rendered CSS skips the DOM when nothing changed.
   * A converged panel therefore costs one lerp per frame and zero style invalidations.
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

  // Remove the inline overrides rather than writing the defaults back — the
  // stylesheet's own :root wins again, so the two can never drift apart.
  const revert = () => {
    stopLoop();
    flipping = false;
    current = null;
    palette = null;      // stop the breath: an unreadable page has no colours to keep pulsing
    polarity = 'dark';   // the stylesheet we fall back to IS dark — hysteresis must agree
    if (!tinted) return;
    for (const cssVar of Object.values(TOKEN_VARS)) root.style.removeProperty(cssVar);
    root.style.removeProperty(GRADIENT_VAR);
    document.body.classList.remove('tinted', 'tinted-light');
    lastPaintKey = '';
    tinted = false;
  };

  // ── The follower ─────────────────────────────────────────────────────────

  /** Where the panel wants to be right now, given the latest sample and the breath phase. */
  const desired = () => tintTokens(palette, phase, polarity);

  const stopLoop = () => { cancelAnimationFrame(rafId); rafId = 0; };

  /**
   * One frame of exponential approach toward a live target.
   *
   * `current` carries FLOAT channels: lerpTokens must not round, or a 0.0075 step would
   * quantise back to zero every frame and the panel would never move. It approaches the
   * target asymptotically and never formally arrives — but once inside half a colour step
   * the rendered hex stops changing, paint() skips the DOM, and a settled panel costs one
   * lerp per frame and no style invalidation. The breath keeps the target moving anyway.
   */
  const tick = (now) => {
    if (disposed || !palette || flipping) { rafId = 0; return; }

    // Reduced-motion can be toggled ON mid-drift, and this loop is perpetual — without a
    // per-frame check it would keep animating forever, which is exactly what the media
    // query exists to prevent. Land on the target and stop; adopt()'s own RM branch keeps
    // tracking the tab from there, and a later toggle OFF resumes via startLoop.
    if (prefersReducedMotion()) { rafId = 0; snapTo(desired()); return; }

    const dt = Math.min(now - lastFrameAt, MAX_FRAME_DT_MS);
    lastFrameAt = now;

    phase += (dt / BREATH_PERIOD_MS) * REGION_COUNT;

    const k = 1 - Math.exp(-dt / FOLLOW_TAU_MS);
    current = lerpTokens(current, desired(), k);
    paint(current);

    rafId = requestAnimationFrame(tick);
  };

  const startLoop = () => {
    if (disposed || rafId || flipping || prefersReducedMotion()) return;
    if (!palette || !current || document.hidden) return;
    lastFrameAt = performance.now();
    rafId = requestAnimationFrame(tick);
  };

  const snapTo = (tokens) => {
    stopLoop();
    flipping = false;
    current = tokens;
    paint(tokens);
  };

  /**
   * The polarity crossfade — the one motion that is NOT followed. Surfaces interpolate
   * while the foreground is CHOSEN per frame, swapping at the contrast crossover. The
   * follower is parked for its duration: bending a crossfade mid-flight would re-cross
   * the trough, and the trough is the one place the panel dips below its contrast floor.
   *
   * `to` is a BRIDGE, not the destination — the on-screen colours at the new polarity.
   * On landing this hands back to the follower, which drifts on to the real target.
   */
  const crossfade = (to) => {
    stopLoop();
    flipping = true;

    const from = current;
    const t0 = performance.now();

    const step = (now) => {
      if (disposed) { rafId = 0; return; }
      if (prefersReducedMotion()) { snapTo(to); return; }

      const p = Math.min(1, (now - t0) / FLIP_MS);
      current = flipTokens(from, to, easeInOut(p));
      paint(current);

      if (p < 1) { rafId = requestAnimationFrame(step); return; }
      current = to;
      rafId = 0;
      flipping = false;
      startLoop();   // hand the panel back to the follower
    };
    rafId = requestAnimationFrame(step);
  };

  /** Adopt a fresh sample. Decides between snap, crossfade, and simply letting the follower chase. */
  const adopt = (fresh) => {
    const nextPolarity = polarityFor(fresh.dominant, polarity);
    const first = !current;
    const prevPalette = palette;

    if (prefersReducedMotion()) { polarity = nextPolarity; palette = fresh; snapTo(desired()); return; }
    if (first) { polarity = nextPolarity; palette = fresh; snapTo(desired()); startLoop(); return; }

    if (nextPolarity !== polarity) {
      // Cross ONLY the scheme: the colours already on screen, re-rendered at the new
      // polarity. Fast, because the crossover trough is unavoidable and must be brief.
      // Then the follower takes the colour journey to `fresh` at its own slow pace — so a
      // light-to-dark tab switch reads as a quick scheme change followed by a long drift,
      // not as a minute spent inside the trough.
      const bridge = tintTokens(prevPalette, phase, nextPolarity);
      polarity = nextPolarity;
      palette = fresh;
      crossfade(bridge);   // on landing it calls startLoop(); tick() then chases `fresh`
      return;
    }

    // Same polarity: nothing to do but keep following. tick() reads `palette` next frame.
    palette = fresh;
    startLoop();
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

  /** Single owner of the capture timer, so the interval and the event triggers can't collide. */
  const captureIn = (delay) => {
    if (disposed) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { void capture(); }, delay);
  };

  const capture = async () => {
    if (disposed || document.hidden) return;

    // Too soon for Chrome's ~2/sec quota. DEFER rather than drop: dropping would swallow
    // the retry a transient failure just scheduled, stranding `failures` at 1 forever.
    const since = Date.now() - lastCaptureAt;
    if (since < MIN_CAPTURE_INTERVAL_MS) { captureIn(MIN_CAPTURE_INTERVAL_MS - since); return; }

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
      // The page was readable, so this is transient: Chrome's throttle, a backgrounded
      // window, or the tab navigating mid-capture. Retry once before giving up —
      // reverting on the first blip would flicker the panel for nothing.
      if (token !== inFlight) return;
      if (++failures < MAX_CONSECUTIVE_FAILURES) schedule();
      else { revert(); failures = 0; }
      return;
    }

    if (disposed || token !== inFlight) return;   // a newer capture already landed
    failures = 0;
    adopt(samplePalette(image));
  };

  const schedule = () => captureIn(DEBOUNCE_MS);

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

  const onUpdated = (tabId, changeInfo) => {
    if (!changeInfo.status && !changeInfo.url) return;
    void isOurActiveTab(tabId).then((ours) => { if (ours) schedule(); });
  };

  const onFocusChanged = (id) => { if (id === windowId) schedule(); };

  const onVisibility = () => {
    if (document.hidden) { stopLoop(); return; }
    startLoop();
    schedule();
  };

  chrome.tabs.onActivated.addListener(onActivated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.windows.onFocusChanged.addListener(onFocusChanged);
  document.addEventListener('visibilitychange', onVisibility);

  // The sampling clock. This — not any scroll listener, which the panel cannot install on
  // the page — is what makes a scroll move the gradient. capture() no-ops on a hidden
  // document and self-throttles, so a backgrounded panel costs nothing.
  sampleTimer = setInterval(() => { void capture(); }, SAMPLE_MS);

  void capture();

  return {
    refresh: schedule,
    dispose() {
      disposed = true;
      clearTimeout(debounceTimer);
      clearInterval(sampleTimer);
      stopLoop();
      try { chrome.tabs.onActivated.removeListener(onActivated); } catch { /* */ }
      try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch { /* */ }
      try { chrome.windows.onFocusChanged.removeListener(onFocusChanged); } catch { /* */ }
      document.removeEventListener('visibilitychange', onVisibility);
      revert();
    },
  };
}
