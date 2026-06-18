// Services/Chat/devBridge.test.js — DBR-4 unit tests for the `lt` live-test verb matcher
// (docs/DESIGN_dev_branches.md §4). PURE: imports only the exported `isLiveTest` matcher — no chrome / no port.
// Run via `npm test` (the glob includes Services/Chat/*.test.js).
//
// Acceptance (DBR-4): bare `lt`/`live`/`live test`/`livetest` fire; a longer sentence merely CONTAINING
// "live test" does NOT (whole-message match only). The dev-conversation gate (non-dev never intercepts) is
// enforced by the caller in maybeHandle (`devConv && isLiveTest(t)`) and verified live, not here.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isLiveTest, isLiveTestForce, isSync, planSync, isMerge, planMergePrepare, buildMergeSummary, buildMergeCommitMessage, mergeHasChanges, isMainStale } from './devBridge.js';

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

// DBR-P2-3 (DESIGN §6) — the `merge` verb matcher + the prepare-half sequencing.
describe('isMerge — whole-message `merge` fires; a sentence containing "merge" does not', () => {
  it('fires for the bare token, case/space-tolerant', () => {
    for (const s of ['merge', 'MERGE', '  merge  ', 'Merge']) assert.equal(isMerge(s), true, `should fire: ${JSON.stringify(s)}`);
  });
  it('does NOT fire for embedded / partial / empty', () => {
    for (const s of ['merge it', 'can you merge', 'merge main', 'merged', 'premerge', '', null, undefined]) {
      assert.equal(isMerge(s), false, `should NOT fire: ${String(s)}`);
    }
  });
});

describe('planMergePrepare — sync → test (1 retry) → diff sequencing', () => {
  it('sync not-clean → stop at sync, never reaches the diff', () => {
    for (const sync of ['conflict', 'error', undefined]) {
      const r = planMergePrepare({ sync });
      assert.deepEqual(r, { outcome: 'stopped', stoppedAt: 'sync', ranDiff: false, retried: false }, `sync=${sync}`);
    }
  });
  it('sync clean + tests pass first try → ready, diff, no retry', () => {
    assert.deepEqual(planMergePrepare({ sync: 'clean', test1: 'pass' }),
      { outcome: 'ready', stoppedAt: null, ranDiff: true, retried: false });
  });
  it('sync clean + green on the retry → ready, diff, retried', () => {
    assert.deepEqual(planMergePrepare({ sync: 'clean', test1: 'fail', test2: 'pass' }),
      { outcome: 'ready', stoppedAt: null, ranDiff: true, retried: true });
  });
  it('sync clean + still red after the retry → stop at test, BEFORE the diff (no merge)', () => {
    assert.deepEqual(planMergePrepare({ sync: 'clean', test1: 'fail', test2: 'fail' }),
      { outcome: 'stopped', stoppedAt: 'test', ranDiff: false, retried: true });
  });
});

// DBR-P2-4 (DESIGN §6.1/§6.3) — the merge-summary + squash commit message builders.
describe('buildMergeSummary — subject from concern/title, files from the diff-stat', () => {
  it('prefers the concern, falls back to title, then a default', () => {
    assert.equal(buildMergeSummary({ concern: 'drawer UI', title: 'X' }).subject, 'drawer UI');
    assert.equal(buildMergeSummary({ title: 'export pipeline' }).subject, 'export pipeline');
    assert.equal(buildMergeSummary({}).subject, 'merge dev branch');
  });
  it('splits the diff-stat into file lines + caps a long subject to one line', () => {
    const r = buildMergeSummary({ concern: 'a\nb   c', diffStat: ' chat.js | 3 +\n Core/x.js | 1 -\n' });
    assert.equal(r.subject.includes('\n'), false);
    assert.deepEqual(r.files, ['chat.js | 3 +', 'Core/x.js | 1 -']);
  });
});

describe('buildMergeCommitMessage — subject + changes + Dev-conversation trailer (§6.3)', () => {
  it('embeds the subject, the changed files, and the conversation trailer', () => {
    const msg = buildMergeCommitMessage({ subject: 'drawer UI', files: ['chat.js | 3 +'] }, 'conv-abc');
    const lines = msg.split('\n');
    assert.equal(lines[0], 'drawer UI');                       // subject first
    assert.ok(msg.includes('Changes:') && msg.includes('chat.js | 3 +'));
    assert.ok(msg.endsWith('Dev-conversation:conv-abc'));      // trailer last
  });
  it('includes a Learned line when present; defaults the subject; stays a string', () => {
    const msg = buildMergeCommitMessage({ subject: '', learned: 'X breaks Y' }, 'c1');
    assert.ok(msg.startsWith('merge dev branch'));
    assert.ok(msg.includes('Learned: X breaks Y'));
    assert.ok(msg.includes('Dev-conversation:c1'));
  });
  it('is robust to a nullish summary (no throw)', () => {
    assert.ok(buildMergeCommitMessage(null, 'c2').includes('Dev-conversation:c2'));
  });
});

// DBR-P2-4 fix (live-test) — a branch with no changes vs main must NOT be offered for landing (empty squash →
// `git commit` fails "nothing to commit").
describe('mergeHasChanges — empty diff-stat means nothing to land', () => {
  it('false for empty / whitespace / nullish; true for any real diff line', () => {
    for (const d of ['', '   ', '\n\t ', null, undefined]) assert.equal(mergeHasChanges(d), false, `empty: ${JSON.stringify(d)}`);
    assert.equal(mergeHasChanges(' chat.js | 3 +\n 1 file changed'), true);
  });
});

// DBR-P2-5 (DESIGN §7.2) — freshness: did `main` move between prepare and the land confirm?
describe('isMainStale — re-sync before landing iff main moved', () => {
  it('equal → fresh (land directly); differ → stale (re-sync)', () => {
    assert.equal(isMainStale('abc123', 'abc123'), false);
    assert.equal(isMainStale('abc123', 'def456'), true);
  });
  it('unknown synced-onto but main readable → stale (re-sync to be safe)', () => {
    assert.equal(isMainStale('', 'def456'), true);
    assert.equal(isMainStale(null, 'def456'), true);
  });
  it('main unreadable → NOT stale (don\'t block; gated current=main + token guards still apply)', () => {
    assert.equal(isMainStale('abc123', ''), false);
    assert.equal(isMainStale(null, null), false);
  });
});
