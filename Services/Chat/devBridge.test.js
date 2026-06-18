// Services/Chat/devBridge.test.js — DBR-4 unit tests for the `lt` live-test verb matcher
// (docs/DESIGN_dev_branches.md §4). PURE: imports only the exported `isLiveTest` matcher — no chrome / no port.
// Run via `npm test` (the glob includes Services/Chat/*.test.js).
//
// Acceptance (DBR-4): bare `lt`/`live`/`live test`/`livetest` fire; a longer sentence merely CONTAINING
// "live test" does NOT (whole-message match only). The dev-conversation gate (non-dev never intercepts) is
// enforced by the caller in maybeHandle (`devConv && isLiveTest(t)`) and verified live, not here.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isLiveTest, isLiveTestForce, isSync, planSync } from './devBridge.js';

describe('isLiveTest — whole-message live-test triggers fire', () => {
  it('matches the bare tokens', () => {
    for (const s of ['lt', 'live', 'live test', 'livetest']) {
      assert.equal(isLiveTest(s), true, `should fire: ${s}`);
    }
  });
  it('is case-insensitive and whitespace-tolerant', () => {
    for (const s of ['LT', 'Lt', 'Live', 'LIVE TEST', 'Live Test', '  lt  ', 'live   test', '\tlivetest\n']) {
      assert.equal(isLiveTest(s), true, `should fire: ${JSON.stringify(s)}`);
    }
  });
});

describe('isLiveTest — a sentence merely containing the phrase does NOT fire (flows to Claude)', () => {
  it('rejects longer prompts that embed the trigger', () => {
    for (const s of [
      'can you live test the search box?',
      'live test the parser',
      "let's live test",
      'lt the drawer',
      'please lt',
      'is this live?',
      'go live',
      'livetesting',
      'live-test',           // hyphenated is not one of the four exact tokens
    ]) {
      assert.equal(isLiveTest(s), false, `should NOT fire: ${s}`);
    }
  });
  it('rejects empty / nullish / non-string input', () => {
    for (const s of ['', '   ', null, undefined, 0, {}, []]) {
      assert.equal(isLiveTest(s), false, `should NOT fire: ${String(s)}`);
    }
  });
});

// v2.74.1043 (DESIGN §4 guardrail) — the FORCE variant: a bare lt token + trailing `!`/` force` overrides the
// behind-main warning ("switch anyway"). Same whole-message discipline; disjoint from the bare matcher.
describe('isLiveTestForce — bare token + trailing `!`/`force` fires (override)', () => {
  it('matches the force suffixes, case/space-tolerant', () => {
    for (const s of ['lt!', 'lt force', 'live!', 'livetest!', 'live test!', 'live force', 'live test force',
                     'LT!', 'Lt Force', '  livetest  force  ', 'lt !']) {
      assert.equal(isLiveTestForce(s), true, `should force: ${JSON.stringify(s)}`);
    }
  });
  it('does NOT fire for the bare tokens (those go through isLiveTest, not force)', () => {
    for (const s of ['lt', 'live', 'live test', 'livetest']) {
      assert.equal(isLiveTestForce(s), false, `should NOT force: ${s}`);
      assert.equal(isLiveTest(s), true, `bare should still match isLiveTest: ${s}`);
    }
  });
  it('does NOT fire for a sentence merely containing force/!, or bare force', () => {
    for (const s of ['can you force a live test!', 'please lt the drawer!', 'force', '!', 'force lt', '', null, undefined]) {
      assert.equal(isLiveTestForce(s), false, `should NOT force: ${String(s)}`);
    }
  });
});

// DBR-P2-2 (DESIGN §5/§6.2) — the `sync` verb matcher + the syncMain-result classifier.
describe('isSync — whole-message `sync` fires; a sentence containing "sync" does not', () => {
  it('fires for the bare token, case/space-tolerant', () => {
    for (const s of ['sync', 'SYNC', '  sync  ', 'Sync']) assert.equal(isSync(s), true, `should fire: ${JSON.stringify(s)}`);
  });
  it('does NOT fire for embedded / partial / empty', () => {
    for (const s of ['sync the branch', 'can you sync', 'syncing', 'resync', 'sync main', '', null, undefined, 42]) {
      assert.equal(isSync(s), false, `should NOT fire: ${String(s)}`);
    }
  });
});

describe('planSync — classifies a syncMain git result (clean / conflict / error)', () => {
  it('ok result → clean', () => {
    assert.deepEqual(planSync({ ok: true, stdout: 'Already up to date.' }), { status: 'clean', files: [], detail: '' });
  });
  it('merge-conflict output → conflict + the conflicted files', () => {
    const r = planSync({ ok: false, code: 1,
      stderr: 'Auto-merging Core/foo.js\nCONFLICT (content): Merge conflict in Core/foo.js\nCONFLICT (content): Merge conflict in chat.js\nAutomatic merge failed; fix conflicts and then commit the result.' });
    assert.equal(r.status, 'conflict');
    assert.deepEqual(r.files, ['Core/foo.js', 'chat.js']);
  });
  it('a non-conflict failure → error (first line, capped); host-unreachable → error', () => {
    assert.equal(planSync({ ok: false, stderr: 'fatal: not something we can merge' }).status, 'error');
    assert.equal(planSync({ ok: false, error: 'host unreachable: port closed' }).status, 'error');
    assert.equal(planSync(null).status, 'error');   // defensive: nullish result is not "clean"
  });
});
