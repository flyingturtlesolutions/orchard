// Core/Logger.test.js — CR-T1 (v2.74.921): the ErrorCapture reentrancy guard must be HELD while Logger
// mirrors an entry to the console. Without it, the console patch (Core/ErrorCapture.patchConsoleMethod)
// re-ingested every direct Logger.warn/error as a second persisted entry whose "source" was the
// [timestamp] prefix — the duplicate WARN/ERROR lines in every live trace. PURE-ish: console is stubbed;
// persistence is disabled so no chrome.* is touched.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Logger, LOG_LEVEL } from './Logger.js';

// Capture console calls + whether the guard global was set AT CALL TIME (what ErrorCapture's patch reads).
function withStubbedConsole(fn) {
  const calls = { warn: [], error: [], log: [], debug: [] };
  const orig = { warn: console.warn, error: console.error, log: console.log, debug: console.debug };
  for (const k of Object.keys(calls)) {
    console[k] = (...args) => { calls[k].push({ guard: !!globalThis.__agentHubInsideLogger, args }); };
  }
  try { fn(calls); } finally { Object.assign(console, orig); }
  return calls;
}

describe('Logger — ErrorCapture guard held across the console mirror (CR-T1)', () => {
  it('sets the guard during warn/error mirrors and restores it after', () => {
    Logger.setPersist(false);   // no chrome.storage in unit tests (the documented test affordance)
    const calls = withStubbedConsole(() => {
      Logger.warn('TestSrc', 'a warning');
      Logger.error('TestSrc', 'an error');
    });
    assert.equal(calls.warn.length, 1);
    assert.equal(calls.error.length, 1);
    assert.equal(calls.warn[0].guard, true, 'guard TRUE during the warn mirror — the patch must skip it');
    assert.equal(calls.error[0].guard, true, 'guard TRUE during the error mirror');
    assert.ok(!globalThis.__agentHubInsideLogger, 'guard restored after the mirror');
  });

  it('restores a PRE-SET guard instead of clearing it (console→Logger→console nesting)', () => {
    globalThis.__agentHubInsideLogger = true;   // simulate being inside ErrorCapture's wrapper
    try {
      withStubbedConsole(() => { Logger.warn('TestSrc', 'nested'); });
      assert.equal(globalThis.__agentHubInsideLogger, true, 'outer wrapper guard untouched');
    } finally { globalThis.__agentHubInsideLogger = undefined; }
  });

  it('mirror carries the [timestamp] [LEVEL] [source] prefix the patch must NOT re-parse as a source', () => {
    const calls = withStubbedConsole(() => { Logger.warn('TemplateWalker', 'optional step failed'); });
    const first = String(calls.warn[0].args[0]);
    assert.match(first, /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] \[WARN\] \[TemplateWalker\]$/);
  });
});
