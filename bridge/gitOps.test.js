// bridge/gitOps.test.js — DBR-1 unit tests for the dev-branch git allowlist (docs/DESIGN_dev_branches.md §3).
// ESM (the harness loader force-loads .js as ESM); default-imports the CommonJS module under test.
// Run via `npm test` (the glob includes bridge/*.test.js). PURE — no spawning, no filesystem.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import gitOps from './gitOps.cjs';
const { validateBranchName, validRef, validSwitchTarget, buildGitArgs, ALLOWED_OPS, commitMsg, hasConfirm } = gitOps;

describe('gitOps.validateBranchName — only well-formed dev/… branches', () => {
  it('accepts dev/… with safe chars', () => {
    assert.equal(validateBranchName('dev/drawer-fix'), true);
    assert.equal(validateBranchName('dev/format_util.2-abc123'), true);
  });
  it('rejects non-dev branches, main, and bad shapes', () => {
    for (const n of ['main', 'feature/x', 'dev', 'dev/', 'dev/-leading', 'devx/y', 'release']) {
      assert.equal(validateBranchName(n), false, `should reject ${n}`);
    }
  });
  it('rejects traversal, metacharacters, and non-strings (acceptance c)', () => {
    for (const n of ['dev/../main', 'dev/a..b', 'dev/a b', 'dev/a;rm -rf', 'dev/a$(x)', 'dev/a|b',
      'dev/a&b', 'dev/a`b`', 'dev/a~b', 'dev/a^b', 'dev/a:b', 'dev/a?b', 'dev/a*b', 'dev/a\\b',
      'dev/a"b', "dev/a'b", null, undefined, 42, {}]) {
      assert.equal(validateBranchName(n), false, `should reject ${String(n)}`);
    }
  });
});

describe('gitOps.validRef / validSwitchTarget', () => {
  it('validRef accepts HEAD, branches, shas; rejects ranges/metachars', () => {
    assert.equal(validRef('HEAD'), true);
    assert.equal(validRef('main'), true);
    assert.equal(validRef('dev/x'), true);
    assert.equal(validRef('a1b2c3d'), true);
    assert.equal(validRef('a..b'), false);
    assert.equal(validRef('a b'), false);
    assert.equal(validRef('$(x)'), false);
    assert.equal(validRef(''), false);
  });
  it('validSwitchTarget allows main or dev/…, nothing else', () => {
    assert.equal(validSwitchTarget('main'), true);
    assert.equal(validSwitchTarget('dev/x'), true);
    assert.equal(validSwitchTarget('feature/y'), false);
    assert.equal(validSwitchTarget('evil; rm'), false);
  });
});

describe('gitOps.buildGitArgs — valid ops build the expected argv (acceptance a)', () => {
  it('read ops', () => {
    assert.deepEqual(buildGitArgs('status').argv, ['status', '--porcelain=v1', '--branch']);
    assert.deepEqual(buildGitArgs('currentBranch').argv, ['rev-parse', '--abbrev-ref', 'HEAD']);
    assert.deepEqual(buildGitArgs('branchList').argv, ['branch', '--list', '--format=%(refname:short)']);
    assert.deepEqual(buildGitArgs('revParse', { ref: 'dev/x' }).argv, ['rev-parse', 'dev/x']);
    assert.deepEqual(buildGitArgs('aheadBehind', { a: 'main', b: 'dev/x' }).argv,
      ['rev-list', '--left-right', '--count', 'main...dev/x']);
    assert.deepEqual(buildGitArgs('diffNames', { a: 'main', b: 'dev/x' }).argv, ['diff', '--name-only', 'main...dev/x']);   // DBR-P2-7
    assert.equal(buildGitArgs('diffNames', { a: 'a..b', b: 'x' }).ok, false);   // bad ref rejected
    assert.equal(buildGitArgs('log', { n: 9999 }).argv.at(-1), '200');   // clamped
  });
  it('write ops build argv and are flagged write:true', () => {
    const c = buildGitArgs('branchCreate', { branch: 'dev/x', base: 'main' });
    assert.deepEqual(c.argv, ['branch', 'dev/x', 'main']); assert.equal(c.write, true);
    assert.deepEqual(buildGitArgs('switch', { branch: 'dev/x' }).argv, ['switch', 'dev/x']);
    assert.deepEqual(buildGitArgs('switch', { branch: 'main' }).argv, ['switch', 'main']);
    assert.deepEqual(buildGitArgs('switchDetach', { ref: 'dev/x' }).argv, ['switch', '--detach', 'dev/x']);
    const w = buildGitArgs('commitWip', {});
    assert.equal(w.argv[0], 'commit'); assert.equal(w.write, true);
  });
});

describe('gitOps.buildGitArgs — refuses out-of-policy requests (acceptance b, c, e)', () => {
  it('a non-dev / malicious branch target on a write is refused (b, c)', () => {
    assert.equal(buildGitArgs('branchCreate', { branch: 'feature/x' }).ok, false);
    assert.equal(buildGitArgs('branchCreate', { branch: 'dev/x', base: 'a; rm -rf' }).ok, false);
    assert.equal(buildGitArgs('switch', { branch: 'evil; rm' }).ok, false);
    assert.equal(buildGitArgs('switchDetach', { ref: 'a..b' }).ok, false);
    assert.equal(buildGitArgs('revParse', { ref: '$(whoami)' }).ok, false);
  });
  it('forbidden / unknown ops return unknown-op — no merge/rebase/push/reset/worktree (b)', () => {
    for (const op of ['merge', 'rebase', 'push', 'reset', 'worktree', 'config', 'clean', '']) {
      assert.equal(buildGitArgs(op, {}).ok, false, `should reject ${op}`);
      assert.equal(buildGitArgs(op, {}).error, 'unknown-op');
    }
    assert.ok(!ALLOWED_OPS.includes('merge') && !ALLOWED_OPS.includes('push'));
  });
  it('buildGitArgs never returns a shell string — argv is always an array of plain strings (e)', () => {
    for (const op of ALLOWED_OPS) {
      const r = buildGitArgs(op, { ref: 'dev/x', a: 'main', b: 'dev/x', branch: 'dev/x', message: 'hi', confirmToken: 't' });
      if (r.ok) {
        assert.ok(Array.isArray(r.argv), `${op} argv is an array`);
        assert.ok(r.argv.every((a) => typeof a === 'string'), `${op} argv all strings`);
      }
    }
  });
});

// DBR-P2-1 (DESIGN §6/§7) — the Phase-2 W-gated converge ops. The pure layer enforces argv shape, the dev/…
// SOURCE, and the confirm-token PRESENCE; the host validates the token's VALUE + the current-branch guards.
describe('gitOps Phase-2 converge ops — syncMain / mergeSquash / commitMerge / branchDelete (DBR-P2-1)', () => {
  const TOKEN = 'deadbeefcafe';   // a PRESENT confirm token (value is validated host-side; here we test presence)

  it('syncMain merges main INTO the current branch — no token, write:true, never targets main (d)', () => {
    const r = buildGitArgs('syncMain', {});
    assert.deepEqual(r.argv, ['merge', '--no-edit', 'main']);   // `main` is the SOURCE, current branch is the target
    assert.equal(r.write, true);
    assert.equal(r.argv.includes('--squash'), false);
  });

  it('mergeSquash: dev source + token → argv; refuses without token (b) and non-dev source (c)', () => {
    const okR = buildGitArgs('mergeSquash', { branch: 'dev/x', confirmToken: TOKEN });
    assert.deepEqual(okR.argv, ['merge', '--squash', 'dev/x']); assert.equal(okR.write, true);
    assert.equal(buildGitArgs('mergeSquash', { branch: 'dev/x' }).error, 'needs-confirm');                 // (b)
    assert.equal(buildGitArgs('mergeSquash', { branch: 'main', confirmToken: TOKEN }).error, 'bad-branch'); // (c)
    assert.equal(buildGitArgs('mergeSquash', { branch: 'feature/y', confirmToken: TOKEN }).error, 'bad-branch');
  });

  it('commitMerge: token → `commit -m <msg>` (the one main commit); refuses without token (b)', () => {
    const okR = buildGitArgs('commitMerge', { message: 'Add drawer\n\nDev-conversation:abc', confirmToken: TOKEN });
    assert.deepEqual(okR.argv, ['commit', '-m', 'Add drawer\n\nDev-conversation:abc']); assert.equal(okR.write, true);
    assert.equal(buildGitArgs('commitMerge', { message: 'x' }).error, 'needs-confirm');                    // (b)
  });

  it('branchDelete: dev branch + token → `branch -D`; refuses without token (b) and non-dev (c)', () => {
    const okR = buildGitArgs('branchDelete', { branch: 'dev/x', confirmToken: TOKEN });
    assert.deepEqual(okR.argv, ['branch', '-D', 'dev/x']); assert.equal(okR.write, true);
    assert.equal(buildGitArgs('branchDelete', { branch: 'dev/x' }).error, 'needs-confirm');                // (b)
    assert.equal(buildGitArgs('branchDelete', { branch: 'main', confirmToken: TOKEN }).error, 'bad-branch'); // (c)
  });

  it('the gated ops are allow-listed but plain `merge` still is not (d)', () => {
    for (const op of ['syncMain', 'mergeSquash', 'commitMerge', 'branchDelete']) assert.ok(ALLOWED_OPS.includes(op));
    assert.ok(!ALLOWED_OPS.includes('merge'));
    assert.equal(buildGitArgs('merge', { branch: 'dev/x', confirmToken: TOKEN }).error, 'unknown-op');
  });

  it('commitMsg keeps newlines, strips NULs, caps length; hasConfirm checks presence', () => {
    assert.equal(commitMsg('a\nb'), 'a\nb');                 // newlines preserved (multi-line summary body)
    assert.equal(commitMsg('a\0b'), 'ab');                   // NUL stripped
    assert.equal(commitMsg('   '), 'Merge dev branch');      // blank → default
    assert.equal(commitMsg(null), 'Merge dev branch');
    assert.ok(commitMsg('x'.repeat(5000)).length <= 4000);   // capped
    assert.equal(hasConfirm({ confirmToken: 'x' }), true);
    assert.equal(hasConfirm({ confirmToken: '' }), false);
    assert.equal(hasConfirm({}), false);
  });
});
