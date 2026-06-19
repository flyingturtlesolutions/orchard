// Services/Chat/worktreeGc.test.js — DBR-P4-7 (DESIGN §9/U10): the worktree GC plan.
// PURE: imports only gcPlan + isLiveStatus — no chrome / no git / no port.
// Run via `npm test` (the glob includes Services/Chat/*.test.js).
//
// Acceptance (DBR-P4-7): keep/remove/surface/prune per the 4 rules; the SAFETY property — an orphan worktree
// with unmerged work is NEVER in `remove` (always `surface`); the Chrome preview worktree is never removed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { gcPlan, isLiveStatus } from './worktreeGc.js';

const has = (arr, path) => arr.some((x) => x.path === path);

describe('isLiveStatus', () => {
  it('treats undefined / active / unknown as live', () => {
    for (const s of [undefined, null, '', 'active', 'live', 'draft']) assert.equal(isLiveStatus(s), true, `live: ${s}`);
  });
  it('treats merged / abandoned (any case) as not live', () => {
    for (const s of ['merged', 'abandoned', 'MERGED', 'Abandoned']) assert.equal(isLiveStatus(s), false, `done: ${s}`);
  });
});

describe('gcPlan — keep / remove by conversation status', () => {
  it('keeps a worktree owned by a live conversation', () => {
    const plan = gcPlan(
      [{ path: '.wt/a', branch: 'dev/session-a' }],
      [{ branch: 'dev/session-a', status: 'active' }],
    );
    assert.ok(has(plan.keep, '.wt/a'));
    assert.equal(plan.remove.length + plan.surface.length + plan.prune.length, 0);
  });
  it('removes a worktree whose conversation is merged or abandoned', () => {
    const plan = gcPlan(
      [{ path: '.wt/m', branch: 'dev/session-m' }, { path: '.wt/x', branch: 'dev/session-x' }],
      [{ branch: 'dev/session-m', status: 'merged' }, { branch: 'dev/session-x', status: 'abandoned' }],
    );
    assert.ok(has(plan.remove, '.wt/m'));
    assert.ok(has(plan.remove, '.wt/x'));
    assert.equal(plan.keep.length, 0);
  });
});

describe('gcPlan — the safety rule: never auto-delete unmerged orphan work', () => {
  it('SURFACES an orphan worktree with unmerged work (never removes it)', () => {
    const plan = gcPlan(
      [{ path: '.wt/orphan', branch: 'dev/session-orphan', unmerged: true }],
      [],   // no conversation owns it
    );
    assert.ok(has(plan.surface, '.wt/orphan'), 'must be surfaced');
    assert.ok(!has(plan.remove, '.wt/orphan'), 'must NOT be removed');
  });
  it('removes a clean orphan (no conversation, no unmerged work)', () => {
    const plan = gcPlan(
      [{ path: '.wt/clean', branch: 'dev/session-clean', unmerged: false }],
      [],
    );
    assert.ok(has(plan.remove, '.wt/clean'));
    assert.ok(!has(plan.surface, '.wt/clean'));
  });
});

describe('gcPlan — preview / stale / detached', () => {
  it('always keeps the preview worktree, even with no conversation', () => {
    const plan = gcPlan([{ path: '.wt/preview', branch: null, preview: true }], []);
    assert.ok(has(plan.keep, '.wt/preview'));
    assert.equal(plan.remove.length, 0);
  });
  it('prunes a stale registration (working dir gone)', () => {
    const plan = gcPlan([{ path: '.wt/gone', branch: 'dev/session-gone', stale: true }], []);
    assert.ok(has(plan.prune, '.wt/gone'));
    assert.equal(plan.remove.length, 0);
  });
  it('surfaces a detached/no-branch worktree that is not the preview', () => {
    const plan = gcPlan([{ path: '.wt/detached', branch: null }], []);
    assert.ok(has(plan.surface, '.wt/detached'));
    assert.ok(!has(plan.remove, '.wt/detached'));
  });
});

describe('gcPlan — input hygiene', () => {
  it('returns an empty plan for empty / nullish inputs', () => {
    for (const [w, c] of [[[], []], [null, null], [undefined, undefined]]) {
      const plan = gcPlan(w, c);
      assert.deepEqual(plan, { keep: [], remove: [], surface: [], prune: [] });
    }
  });
  it('skips worktree entries with no path', () => {
    const plan = gcPlan([{ branch: 'dev/x' }, null, { path: '.wt/ok', branch: 'dev/ok' }], []);
    assert.equal(plan.keep.length + plan.remove.length + plan.surface.length + plan.prune.length, 1);
    assert.ok(has(plan.remove, '.wt/ok'));   // orphan, clean → remove
  });
});
