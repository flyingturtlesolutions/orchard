// Core/focusGrammar.js — FM-1: the focus-grab decision (pure).
//
// Tab/window focus is fully programmable for an extension (no gesture law — unlike sidePanel.open),
// which makes the POLICY the whole design: an unwanted grab mid-keystroke is hostile, and a stray
// Enter meant for the user's tab must never land on a just-focused one. This module DECIDES; the
// FOCUS_TAB handler (background/handlers/sg.js focusTabPolicy) gathers state and acts.
//
// Two grab classes:
//   REQUIRED — the interaction physically needs the tab active (walk teach steps: pickers/demos/
//              replays drive the ACTIVE tab). The setting cannot veto these — they are part of an
//              action the user initiated, and suppressing them breaks the flow rather than
//              protecting the user.
//   COURTESY — informational surfacing (a run finished/failed on a background tab). Governed by the
//              'autoFocus' setting: 'auto' grabs, 'never' suppresses, 'ask' defers (recorded as its
//              own verdict so the trace shows intent; FM-2's soft-invite consumes it — until then a
//              deferral surfaces nothing, same as suppressed).
//
// Already-active wins over everything: focusing the focused tab is pure log noise.
//
// PURE: no chrome. @module Core/focusGrammar

export const FOCUS_SETTING_KEY = 'autoFocus';
export const FOCUS_SETTING_VALUES = ['auto', 'ask', 'never'];

/**
 * Decide a focus grab.
 * @param {string} setting  'auto' | 'ask' | 'never' (anything else falls back to 'auto')
 * @param {{required?: boolean, alreadyActive?: boolean}} [c]
 * @returns {'focus'|'skip-active'|'suppressed-setting'|'deferred-ask'}
 */
export function focusDecision(setting, { required = false, alreadyActive = false } = {}) {
  if (alreadyActive) return 'skip-active';
  if (required) return 'focus';
  const s = FOCUS_SETTING_VALUES.includes(setting) ? setting : 'auto';
  if (s === 'auto') return 'focus';
  return s === 'ask' ? 'deferred-ask' : 'suppressed-setting';
}
