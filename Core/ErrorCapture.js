/**
 * @file Core/ErrorCapture.js
 * @description Global error capture — wires `error` and `unhandledrejection`
 * listeners to the Logger so uncaught exceptions and unhandled promise
 * rejections appear in the Studio Logs tab alongside explicit Logger.error()
 * calls.
 *
 * Why this exists:
 *   The Logger only persists entries that are explicitly passed to its
 *   .error() / .warn() / etc. methods (Core/Logger.js #emit). Anything
 *   thrown out of a try/catch or rejected from an un-awaited Promise
 *   never reaches Logger and so never appears in the Logs tab — which
 *   the user reported as "no error entries despite numerous crashes."
 *
 *   This module installs global handlers that catch those escaped
 *   errors and route them through Logger.error() so they're persisted
 *   to chrome.storage.local (key 'logger:entries', ring-buffered) and
 *   broadcast via the 'LOG_ENTRY' runtime message.
 *
 * Install one per context:
 *   - background service worker → installGlobalErrorHandlers('background', self)
 *   - sidepanel page (chat/sidepanel/studio) → installGlobalErrorHandlers('<page>', window)
 *
 * The global object differs by context:
 *   - Service worker: `self` (no `window`)
 *   - DOM document:   `window`
 *   Both support `addEventListener('error', ...)` and
 *   `addEventListener('unhandledrejection', ...)` per spec.
 *
 * Limitations:
 *   - Service worker crashes that kill the worker before the handler runs
 *     can't be caught (Chrome provides no pre-termination hook). The
 *     handlers DO catch the more common case: a thrown error or rejected
 *     promise that the runtime would otherwise log to DevTools console
 *     and discard.
 *   - Content scripts run in an isolated world and aren't ES modules in
 *     this codebase — they'd need an inline copy of this logic if their
 *     errors need capturing. Skipped for now.
 *
 * @module Core/ErrorCapture
 */

import { Logger } from './Logger.js';

/**
 * Serialize an Error (or anything thrown) to a plain object that
 * structured-clones cleanly through chrome.storage.local. Errors have
 * non-enumerable name/message/stack so JSON.stringify gives "{}";
 * Logger persists `data` via chrome.storage.local.set which uses
 * structured clone — Error instances technically clone but properties
 * are lost in some Chrome versions, so this normalization is safer.
 *
 * @param {unknown} err
 * @returns {Object}
 */
function normalizeError(err) {
  if (err == null) return { name: 'Error', message: 'null/undefined thrown' };
  if (err instanceof Error) {
    return {
      name    : err.name ?? 'Error',
      message : err.message ?? String(err),
      stack   : err.stack  ?? '(no stack)',
    };
  }
  if (typeof err === 'object') {
    try {
      return { name: 'NonErrorObject', value: JSON.parse(JSON.stringify(err)) };
    } catch {
      return { name: 'NonErrorObject', value: String(err) };
    }
  }
  return { name: 'NonErrorThrown', value: String(err) };
}

/**
 * Install global error + unhandledrejection handlers on the given
 * target (`self` for service worker, `window` for DOM pages). Idempotent
 * via a flag stored on the target — installing twice is a no-op.
 *
 * @param {string} contextName  — Source tag for log entries (e.g. 'background', 'studio', 'chat', 'sidepanel').
 * @param {EventTarget} target  — `self` or `window` depending on context.
 */
export function installGlobalErrorHandlers(contextName, target) {
  if (!target || typeof target.addEventListener !== 'function') return;
  // Idempotency guard — multiple calls in one context would double-log.
  // Stored on the target with a Symbol-like string key to avoid colliding
  // with anything else.
  if (target.__agentHubErrorCaptureInstalled) return;
  target.__agentHubErrorCaptureInstalled = true;

  const source = `${contextName}:errorCapture`;

  target.addEventListener('error', (event) => {
    // ErrorEvent carries .error (the thrown value), .message, .filename,
    // .lineno, .colno. .error is null for some cross-origin script errors;
    // fall back to building a synthetic record from the other fields.
    const err = event?.error ?? new Error(event?.message ?? 'uncaught error');
    const normalized = normalizeError(err);
    try {
      Logger.error(source, `Uncaught error: ${normalized.message}`, {
        ...normalized,
        filename: event?.filename ?? null,
        lineno  : event?.lineno   ?? null,
        colno   : event?.colno    ?? null,
      });
    } catch {
      // Logger itself threw — last-ditch console output (Logger.error
      // shouldn't throw, but if chrome.storage is unavailable in some
      // weird context, don't swallow the original signal).
      console.error('[ErrorCapture] Logger.error failed:', normalized);
    }
  });

  target.addEventListener('unhandledrejection', (event) => {
    // PromiseRejectionEvent carries .reason (the rejection value) and
    // .promise. .reason can be anything — Error, string, plain object.
    const reason = event?.reason;
    const normalized = normalizeError(reason);
    try {
      Logger.error(source, `Unhandled promise rejection: ${normalized.message}`, normalized);
    } catch {
      console.error('[ErrorCapture] Logger.error failed:', normalized);
    }
  });

  // v2.74.189 — Patch console.error / console.warn so catch-and-log
  // call sites (the predominant pattern in the codebase — e.g.
  // strategy-debug.js line 122-152, fragment-author.js, observation-
  // author.js all have `} catch (e) { console.warn('[mode] …'); }`)
  // also surface in the Logs tab. Without this, every error that's
  // explicitly caught and console-logged is invisible to the Logs UI
  // — the user reported "strategies debugger just errored out and
  // error logger shows nothing" precisely because of this gap.
  //
  // The patch:
  //   1. Captures the original console method.
  //   2. Replaces it with a wrapper that calls Logger.{warn,error}
  //      THEN the original (so DevTools console still shows the line
  //      with its native styling).
  //   3. Uses a reentrancy guard (_loggerActive flag on the target)
  //      to prevent infinite recursion — Logger's own #emit calls
  //      console.warn/error to mirror to DevTools; without the guard,
  //      that call would re-enter the patch and loop.
  //
  // Limitations: only patches the current global's console. Modules
  // that captured a console reference at import time (none in this
  // codebase that I'm aware of) would bypass the patch.
  const patchConsoleMethod = (methodName, loggerFn) => {
    const orig = target.console?.[methodName];
    if (typeof orig !== 'function') return;
    target.console[methodName] = function(...args) {
      // Run the original first so DevTools output matches expectation
      // (formatted prefix, %c styles, etc., all preserved).
      try { orig.apply(target.console, args); } catch { /* original threw — ignore */ }
      // Reentrancy guard — Logger.#emit calls console.warn/error,
      // which would re-enter this wrapper. Skip when inside Logger.
      if (target.__agentHubInsideLogger) return;
      target.__agentHubInsideLogger = true;
      try {
        // Heuristic: first arg is often the "source tag" like
        // "[strategy-debug]" — extract it for the Logger source field
        // so the Logs tab UI can group by component. Falls back to a
        // generic source if not present.
        let inferredSource = `${contextName}:console.${methodName}`;
        const first = args[0];
        if (typeof first === 'string') {
          const tagMatch = first.match(/^\[([^\]]+)\]/);
          if (tagMatch) inferredSource = `${contextName}:${tagMatch[1]}`;
        }
        // Build the message + data. Stringify args so structured-clone
        // through chrome.storage doesn't choke on circulars / Errors.
        const parts = args.map(a => {
          if (a instanceof Error) {
            return `${a.name}: ${a.message}`;
          }
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch { return String(a); }
        });
        const message = parts.join(' ');
        // Pull Error-typed args out as structured data so the stack
        // survives into the Logs tab.
        const errArgs = args.filter(a => a instanceof Error).map(normalizeError);
        const data = errArgs.length > 0 ? errArgs : null;
        loggerFn.call(Logger, inferredSource, message, data);
      } catch {
        // Patch wrapper must never throw back into caller code.
      } finally {
        target.__agentHubInsideLogger = false;
      }
    };
  };
  patchConsoleMethod('warn',  Logger.warn);
  patchConsoleMethod('error', Logger.error);

  Logger.info(source, `Global error handlers + console patches installed for "${contextName}"`);
}
