// Services/Chat/devBridge.test.js — DBR-4 unit tests for the `lt` live-test verb matcher
// (docs/DESIGN_dev_branches.md §4). PURE: imports only the exported `isLiveTest` matcher — no chrome / no port.
// Run via `npm test` (the glob includes Services/Chat/*.test.js).
//
// Acceptance (DBR-4): bare `lt`/`live`/`live test`/`livetest` fire; a longer sentence merely CONTAINING
// "live test" does NOT (whole-message match only). The dev-conversation gate (non-dev never intercepts) is
// enforced by the caller in maybeHandle (`devConv && isLiveTest(t)`) and verified live, not here.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isLiveTest, isLiveTestForce, isSync, planSync, isMerge, planMergePrepare, buildMergeSummary, buildMergeCommitMessage, mergeHasChanges, isMainStale, isAbandon, isDeleteBranch, isDrift, isFoundationalFile, computeDrift, driftBroadcastSet, isSplit, splitSlug, buildSeedPrompt, isScope, scanImports, resolveImport, buildImportGraph, splitClusters, foundationalAlongsideLeaf, assessSplit, buildSplitNudge, validateProposeSplit, isFork, buildForkSeedPrompt, isScopeSemantic, buildScopeCheckPrompt, normalizeScopeVerdict, archivedSteer } from './devBridge.js';

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

// DBR-P2-6 (DESIGN §5/U13) — abandon verbs: `abandon` (soft) and `delete branch` (hard, gated).
describe('isAbandon / isDeleteBranch — whole-message verbs, disjoint', () => {
  it('isAbandon fires only for the bare word', () => {
    for (const s of ['abandon', 'ABANDON', '  abandon  ']) assert.equal(isAbandon(s), true, `fire: ${JSON.stringify(s)}`);
    for (const s of ['abandon it', 'abandon branch', 'abandoned', '', null, 'delete branch']) assert.equal(isAbandon(s), false, `no: ${String(s)}`);
  });
  it('isDeleteBranch fires only for the exact phrase, whitespace-tolerant', () => {
    for (const s of ['delete branch', 'DELETE BRANCH', '  delete   branch  ']) assert.equal(isDeleteBranch(s), true, `fire: ${JSON.stringify(s)}`);
    for (const s of ['delete branch dev/x', 'delete the branch', 'delete', 'branch', 'abandon', '', null]) assert.equal(isDeleteBranch(s), false, `no: ${String(s)}`);
  });
});

// DBR-P2-7 (DESIGN §7.1) — the `drift` matcher + the deterministic detectors (no LLM).
describe('DBR-P2-7 drift detectors', () => {
  it('isDrift fires only for the bare word', () => {
    for (const s of ['drift', 'DRIFT', '  drift  ']) assert.equal(isDrift(s), true);
    for (const s of ['drift check', 'drifted', '', null]) assert.equal(isDrift(s), false);
  });
  it('isFoundationalFile: under Core/Services OR imported by ≥N (config, not magic)', () => {
    assert.equal(isFoundationalFile('Core/route.js'), true);
    assert.equal(isFoundationalFile('Services/Chat/devBridge.js'), true);
    assert.equal(isFoundationalFile('./Core/x.js'), true);        // leading ./ tolerated
    assert.equal(isFoundationalFile('chat.js'), false);            // leaf file, 0 importers
    assert.equal(isFoundationalFile('chat.js', { importerCount: 3 }), true);   // ≥ default minImporters
    assert.equal(isFoundationalFile('chat.js', { importerCount: 2 }), false);
    assert.equal(isFoundationalFile('lib/x.js', { layers: ['lib/'] }), true);  // config-driven layer
  });
  it('computeDrift: files BOTH main and the branch touched (deduped, branch order)', () => {
    assert.deepEqual(computeDrift(['a', 'b', 'c'], ['c', 'b', 'd']), ['c', 'b']);
    assert.deepEqual(computeDrift(['a'], ['a', 'a']), ['a']);      // deduped
    assert.deepEqual(computeDrift([], ['a']), []);                 // main changed nothing
    assert.deepEqual(computeDrift(['a'], []), []);                 // branch changed nothing
    assert.deepEqual(computeDrift(null, null), []);               // robust to nullish
  });
});

// DBR-P3-1 (DESIGN §8.1) — the split-seeding helpers.
describe('DBR-P3-1 split helpers', () => {
  const DEV_RE = /^dev\/[A-Za-z0-9][A-Za-z0-9._-]*$/;   // mirrors gitOps.validateBranchName's shape
  it('isSplit fires for `split: <concern>` (prefix), not a bare task mentioning split', () => {
    for (const s of ['split: extract the date util', 'SPLIT: x', '  split:  y']) assert.equal(isSplit(s), true, `fire: ${JSON.stringify(s)}`);
    for (const s of ['split the panel into two', 'split:', 'split', 'splitter', '', null]) assert.equal(isSplit(s), false, `no: ${String(s)}`);
  });
  it('splitSlug yields a valid dev/<slug>-<shortid> name, robust to junk concerns', () => {
    assert.match(splitSlug('Fix the Drawer Animation!', 'a1b2c3d4'), DEV_RE);
    assert.equal(splitSlug('fix the drawer', 'a1b2c3d4'), 'dev/fix-the-drawer-a1b2c3d4');
    assert.match(splitSlug('!!!', 'a1b2c3d4'), DEV_RE);                  // empty base → 'split'
    assert.equal(splitSlug('!!!', '').startsWith('dev/split-'), true);  // empty shortid → 'x'
    assert.match(splitSlug('x'.repeat(80), 'deadbeef'), DEV_RE);        // capped, still valid
  });
  it('buildSeedPrompt embeds the concern + an optional parent provenance line', () => {
    assert.equal(buildSeedPrompt({ concern: 'extract X' }), 'extract X');
    assert.ok(buildSeedPrompt({ concern: 'extract X', parentConcern: 'drawer UI' }).includes('Split out from: drawer UI'));
    assert.equal(buildSeedPrompt({}), 'the split-out work');            // default
  });
});

// DBR-P3-2 (DESIGN §8/§8.1 layer 2) — the deterministic split backstop (scope verb + import-graph cluster detector).
describe('DBR-P3-2 scope/split-cluster helpers', () => {
  it('isScope matches the bare `scope` verb, not `scope?` or a task mentioning scope', () => {
    for (const s of ['scope', 'SCOPE', '  scope  ']) assert.equal(isScope(s), true, `fire: ${JSON.stringify(s)}`);
    for (const s of ['scope?', 'scope the work', 'scoped', 'rescope', '', null]) assert.equal(isScope(s), false, `no: ${String(s)}`);
  });

  it('scanImports finds static / re-export / dynamic / require / side-effect specifiers', () => {
    const src = [
      "import { a } from './a.js';",
      "import b from '../b.js';",
      "export { c } from './c.js';",
      "const m = await import('./d.js');",
      "const r = require('./e.cjs');",
      "import './side-effect.js';",
      "import pkg from 'some-package';",       // bare — still a specifier (resolveImport drops it)
    ].join('\n');
    const got = scanImports(src);
    for (const s of ['./a.js', '../b.js', './c.js', './d.js', './e.cjs', './side-effect.js', 'some-package']) {
      assert.ok(got.includes(s), `missing ${s} in ${JSON.stringify(got)}`);
    }
    assert.deepEqual(scanImports('const x = 1; // import nothing here'), []);
  });

  it('resolveImport resolves relative specifiers to repo-relative paths; drops bare ones', () => {
    assert.equal(resolveImport('Services/Chat/devBridge.js', '../ConversationStore.js'), 'Services/ConversationStore.js');
    assert.equal(resolveImport('Services/Chat/devBridge.js', './x.js'), 'Services/Chat/x.js');
    assert.equal(resolveImport('Core/a/b.js', '../../Core/c.js'), 'Core/c.js');
    assert.equal(resolveImport('chat.js', './Services/x.js'), 'Services/x.js');   // root file
    assert.equal(resolveImport('a/b.js', 'react'), null);                          // bare
    assert.equal(resolveImport('a/b.js', 'https://x/y.js'), null);                 // url
  });

  it('buildImportGraph maps each file to its resolved relative imports', () => {
    const g = buildImportGraph({
      'Services/Chat/devBridge.js': "import { ConversationStore } from '../ConversationStore.js'; import 'pkg';",
      'Services/ConversationStore.js': "// no imports",
    });
    assert.deepEqual(g['Services/Chat/devBridge.js'], ['Services/ConversationStore.js']);
    assert.deepEqual(g['Services/ConversationStore.js'], []);
  });

  it('splitClusters: connected diff → 1 component; disconnected → ≥2; deterministic order', () => {
    // A↔B connected (A imports B), C alone.
    const comps = splitClusters(['A.js', 'B.js', 'C.js'], { 'A.js': ['B.js'], 'B.js': [], 'C.js': [] });
    assert.equal(comps.length, 2);
    assert.deepEqual(comps[0], ['A.js', 'B.js']);   // sorted; A < C
    assert.deepEqual(comps[1], ['C.js']);
    // all connected → 1
    assert.equal(splitClusters(['A.js', 'B.js'], { 'A.js': ['B.js'], 'B.js': [] }).length, 1);
    // imports to files OUTSIDE the changed set don't merge components
    assert.equal(splitClusters(['A.js', 'C.js'], { 'A.js': ['unchanged.js'], 'C.js': ['other.js'] }).length, 2);
  });

  it('foundationalAlongsideLeaf flags shared-file-with-leaf only', () => {
    const f = (p) => isFoundationalFile(p);   // Core/ + Services/ are foundational by path
    assert.equal(foundationalAlongsideLeaf(['Core/a.js', 'docs/b.md'], f).flagged, true);
    assert.equal(foundationalAlongsideLeaf(['docs/a.md', 'README.md'], f).flagged, false);  // all leaf
    assert.equal(foundationalAlongsideLeaf(['Core/a.js', 'Services/b.js'], f).flagged, false); // all foundational
  });

  it('assessSplit: cluster needs ≥minFiles; foundational signal independent; combined reasons', () => {
    const f = (p) => isFoundationalFile(p);
    // 3 files, two disconnected code clusters → split-cluster
    const a = assessSplit({ changedFiles: ['x/a.js', 'x/b.js', 'y/c.js'], fileImports: { 'x/a.js': ['x/b.js'], 'x/b.js': [], 'y/c.js': [] }, isFoundational: f });
    assert.ok(a.reasons.includes('split-cluster'));
    // same shape but only 2 files → below minFilesForCluster, no cluster reason
    const b = assessSplit({ changedFiles: ['x/a.js', 'y/c.js'], fileImports: { 'x/a.js': [], 'y/c.js': [] }, isFoundational: f });
    assert.ok(!b.reasons.includes('split-cluster'));
    // foundational + leaf, no import data → foundational reason only
    const c = assessSplit({ changedFiles: ['Core/a.js', 'docs/b.md'], fileImports: {}, isFoundational: f });
    assert.deepEqual(c.reasons, ['foundational-alongside-leaf']);
    // nothing → no nudge
    assert.equal(assessSplit({ changedFiles: ['docs/a.md'], fileImports: {}, isFoundational: f }).shouldNudge, false);
  });

  it('buildSplitNudge renders a nudge only when there is something to flag', () => {
    assert.equal(buildSplitNudge({ reasons: [], components: [], foundational: [] }), null);
    const n = buildSplitNudge({ concern: 'drawer UI', reasons: ['foundational-alongside-leaf', 'split-cluster'], components: [['a'], ['b']], foundational: ['Core/x.js'] });
    assert.ok(n.includes('Core/x.js') && n.includes('2 import-disconnected areas') && n.includes('split:') && n.includes('drawer UI'));
  });
});

// DBR-P3-3 (DESIGN §8.1/U5) — the propose_split typed-tool payload validator (the tool_use -> card mapping).
describe('DBR-P3-3 propose_split validator', () => {
  it('accepts a well-formed proposal and normalizes it (branchBase defaults to main)', () => {
    const r = validateProposeSplit({ concern: '  extract the date util ', reason: 'unrelated to the drawer', seedPrompt: 'Extract formatDate into Core.', suggestedName: 'date util' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { concern: 'extract the date util', reason: 'unrelated to the drawer', branchBase: 'main', seedPrompt: 'Extract formatDate into Core.', suggestedName: 'date util' });
  });
  it('rejects a missing concern (the only required field)', () => {
    for (const input of [{}, { concern: '' }, { concern: '   ' }, { reason: 'x' }, null, 'nope']) {
      assert.equal(validateProposeSplit(input).ok, false, `reject: ${JSON.stringify(input)}`);
    }
  });
  it('allows a dev/… branchBase (split depends on the parent) but rejects an arbitrary ref', () => {
    assert.equal(validateProposeSplit({ concern: 'x', branchBase: 'dev/parent-abc' }).value.branchBase, 'dev/parent-abc');
    for (const bad of ['main~1', 'feature/x', 'HEAD', '../etc', 'dev/..']) {
      assert.equal(validateProposeSplit({ concern: 'x', branchBase: bad }).ok, false, `reject base: ${bad}`);
    }
  });
  it('treats reason / seedPrompt / suggestedName as optional', () => {
    const r = validateProposeSplit({ concern: 'just the concern' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { concern: 'just the concern', reason: '', branchBase: 'main', seedPrompt: '', suggestedName: '' });
  });
});

// DBR-P4 (post-dogfooding guardrail) — a merged/abandoned conversation steers reuse to `fork`.
describe('archivedSteer — merged/abandoned branch reuse → fork', () => {
  it('a MERGED conversation steers off lt/sync/merge to fork, naming the squash commit', () => {
    const s = archivedSteer({ status: 'merged', mergeCommit: '9a2723baaaa' }, 'lt');
    assert.ok(/already \*\*merged\*\*/.test(s));
    assert.ok(s.includes('9a2723b'));               // 7-char short SHA
    assert.ok(/\bfork\b/.test(s));
    assert.ok(s.includes('`lt`'));                  // the verb is interpolated
    assert.ok(archivedSteer({ status: 'merged' }, 'merge').includes('`merge`'));   // no mergeCommit → still steers
  });
  it('an ABANDONED conversation steers to fork', () => {
    const s = archivedSteer({ status: 'abandoned' }, 'sync');
    assert.ok(/\*\*abandoned\*\*/.test(s) && /\bfork\b/.test(s) && s.includes('`sync`'));
  });
  it('an ACTIVE (or missing) conversation returns null — the verb proceeds normally', () => {
    assert.equal(archivedSteer({ status: 'active', branch: 'dev/x' }, 'lt'), null);
    assert.equal(archivedSteer({ branch: 'dev/x' }, 'lt'), null);
    assert.equal(archivedSteer(null, 'lt'), null);
  });
});

// DBR-P3-5 (DESIGN §6.1/U12) — fork-from-here helpers.
describe('DBR-P3-5 fork helpers', () => {
  it('isFork matches the bare `fork` verb only', () => {
    for (const s of ['fork', 'FORK', '  fork  ']) assert.equal(isFork(s), true, `fire: ${JSON.stringify(s)}`);
    for (const s of ['fork the repo', 'forked', 'fork:', '', null]) assert.equal(isFork(s), false, `no: ${String(s)}`);
  });
  it('buildForkSeedPrompt embeds the concern + the continue cue (summary optional)', () => {
    const s = buildForkSeedPrompt({ parentConcern: 'drawer animation', parentSummary: 'shipped the slide, easing TODO' });
    assert.ok(s.includes('Continue the work on: drawer animation'));
    assert.ok(s.includes('Where it left off: shipped the slide, easing TODO'));
    assert.ok(/Forked from a previous dev conversation/.test(s));
  });
  it('falls back to the title, then a generic cue, with no summary line', () => {
    assert.ok(buildForkSeedPrompt({ parentTitle: 'export pipeline' }).includes('Continue the work on: export pipeline'));
    const bare = buildForkSeedPrompt({});
    assert.ok(bare.includes('Continue from the previous dev conversation'));
    assert.equal(bare.includes('Where it left off'), false);
  });
});

// DBR-P3-7 (DESIGN §8.1 layer 3) — the optional semantic scope-check helpers (prompt builder + verdict normalizer).
describe('DBR-P3-7 scope? semantic-check helpers', () => {
  it('isScopeSemantic matches `scope?` only — never the deterministic `scope`', () => {
    for (const s of ['scope?', 'SCOPE?', '  scope?  ']) assert.equal(isScopeSemantic(s), true, `fire: ${JSON.stringify(s)}`);
    for (const s of ['scope', 'scope ?', 'scope??', 'scoped?', '', null]) assert.equal(isScopeSemantic(s), false, `no: ${String(s)}`);
  });

  it('buildScopeCheckPrompt embeds the concern + changed files + diffstat, JSON-only system', () => {
    const { system, user } = buildScopeCheckPrompt({ concern: 'drawer animation', diffStat: ' chat.css | 4 +', changedFiles: ['chat.css', 'Core/x.js'] });
    assert.ok(/Reply ONLY with JSON/.test(system));
    assert.ok(user.includes('STATED CONCERN: drawer animation'));
    assert.ok(user.includes('chat.css') && user.includes('Core/x.js'));
    assert.ok(user.includes('chat.css | 4 +'));
  });

  it('buildScopeCheckPrompt caps a huge diff/file list and tolerates an empty diff', () => {
    const big = buildScopeCheckPrompt({ concern: 'x', diffStat: 'z'.repeat(9000), changedFiles: Array.from({ length: 200 }, (_, i) => `f${i}.js`) });
    assert.ok(big.user.length < 7000);                       // capped
    const empty = buildScopeCheckPrompt({});
    assert.ok(empty.user.includes('(no concern set)') && empty.user.includes('(none)'));
  });

  it('normalizeScopeVerdict coerces raw model text / objects into a safe verdict shape', () => {
    const v = normalizeScopeVerdict('Here you go: {"creep":true,"summary":"two unrelated areas","suggestions":[{"concern":"extract util","reason":"unrelated"},{"concern":"","reason":"drop me"}]}');
    assert.equal(v.creep, true);
    assert.equal(v.summary, 'two unrelated areas');
    assert.equal(v.suggestions.length, 1);                   // the empty-concern suggestion is dropped
    assert.deepEqual(v.suggestions[0], { concern: 'extract util', reason: 'unrelated' });
    // garbage / no-creep / non-JSON → safe empty verdict
    assert.deepEqual(normalizeScopeVerdict('no json here'), { creep: false, summary: '', suggestions: [] });
    assert.deepEqual(normalizeScopeVerdict(null), { creep: false, summary: '', suggestions: [] });
    assert.equal(normalizeScopeVerdict({ creep: false, suggestions: [] }).creep, false);
  });
});

describe('driftBroadcastSet — post-merge cross-branch nudge set (DBR-P4-7)', () => {
  it('includes a branch that touched a merged file, with its drift; excludes non-overlapping', () => {
    const set = driftBroadcastSet(['a.js', 'Core/x.js'], [
      { convId: 'c1', branch: 'dev/session-1', files: ['a.js', 'z.js'] },
      { convId: 'c2', branch: 'dev/session-2', files: ['unrelated.js'] },
    ]);
    assert.equal(set.length, 1);
    assert.equal(set[0].branch, 'dev/session-1');
    assert.equal(set[0].convId, 'c1');
    assert.deepEqual(set[0].drift, ['a.js']);
    assert.equal(set[0].foundational, false);
  });
  it('flags foundational when a drifted file is under Core/ or Services/', () => {
    const set = driftBroadcastSet(['Core/x.js'], [{ convId: 'c1', branch: 'dev/s1', files: ['Core/x.js'] }]);
    assert.equal(set.length, 1);
    assert.equal(set[0].foundational, true);
  });
  it('returns an empty set for no overlap / empty / nullish inputs', () => {
    assert.deepEqual(driftBroadcastSet(['a.js'], [{ convId: 'c', branch: 'dev/s', files: ['b.js'] }]), []);
    assert.deepEqual(driftBroadcastSet([], []), []);
    assert.deepEqual(driftBroadcastSet(null, null), []);
  });
  it('skips entries with no branch', () => {
    const set = driftBroadcastSet(['a.js'], [{ files: ['a.js'] }, { branch: 'dev/s', files: ['a.js'] }]);
    assert.equal(set.length, 1);
    assert.equal(set[0].branch, 'dev/s');
  });
});
