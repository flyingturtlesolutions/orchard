// Core/channelRetry.js — CR-E2 (v2.74.928): channel-error retry policy, split by DELIVERY SEMANTICS.
//
// TemplateWalker.#msg retried every "connection-ish" error on the claim that the message was never
// delivered. True for "Receiving end does not exist" / "Could not establish connection" (no listener —
// nothing ran). FALSE for "the message channel closed before a response was received": that fires when
// the content script RECEIVED the message, possibly EXECUTED it, and was torn down before sendResponse —
// classically, an EXECUTE_STEP CLICK that triggers navigation. Retrying that re-clicks on the new page:
// a real double-submit hazard for apply/send/buy terminals.
//
// Policy: never-delivered errors retry for ANY message type; ambiguous channel-closed retries ONLY for
// message types that are idempotent by construction (reads/probes — re-running cannot change page state).
// New message types default to NOT retrying the ambiguous error (safe default — add them here only after
// deciding they are reads). PURE; mirrors nothing.
//
// @module Core/channelRetry

export const NEVER_DELIVERED_RE = /Receiving end does not exist|Could not establish connection|back\/forward cache/i;
export const CHANNEL_CLOSED_RE = /message channel.*closed/i;

// Every #msg type that only READS or PROBES the page (verified against the live call-site inventory).
// EXECUTE_STEP is deliberately absent — it is the one page-mutating type.
export const IDEMPOTENT_MESSAGE_TYPES = new Set([
  'CHECK_CONDITION', 'CHECK_ELEMENT', 'COUNT_ELEMENTS', 'WAIT_FOR_ELEM', 'FOCUS_CHECK',
  'DOM_SNAPSHOT', 'DOM_SNAPSHOT_RICH', 'DOM_SNAPSHOT_POST_SEND',
  'EXTRACT_VALUE', 'GET_BASELINE_SIGS', 'GET_LAST_ELEMENT_TEXT',
  'OBSERVE_START', 'OBSERVE_READ', 'PAGE_IDLE', 'RESOLVE_IFRAME_BY_PREDICATE',
  'LANDMARK_PROBE_OR_RECOVER',
]);

/**
 * Should this channel error be retried for this message type?
 * @param {string} errMessage   the chrome.runtime.lastError message
 * @param {string} messageType  the message's `type` field
 * @returns {boolean}
 */
export function isRetryableChannelError(errMessage, messageType) {
  const msg = String(errMessage || '');
  if (NEVER_DELIVERED_RE.test(msg)) return true;
  if (CHANNEL_CLOSED_RE.test(msg)) return IDEMPOTENT_MESSAGE_TYPES.has(String(messageType || ''));
  return false;
}

/** Is this the ambiguous executed-then-torn-down error (vs never-delivered)? For caller diagnostics. */
export function isAmbiguousChannelClosed(errMessage) {
  return CHANNEL_CLOSED_RE.test(String(errMessage || '')) && !NEVER_DELIVERED_RE.test(String(errMessage || ''));
}
