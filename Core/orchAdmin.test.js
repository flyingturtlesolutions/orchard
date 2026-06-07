// Core/orchAdmin.test.js — ORCH-ADMIN unit tests (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseAdminCommand, parseDedupCommand, ADMIN_KINDS } from './orchAdmin.js';

describe('orchAdmin — parse admin/management commands (ORCH-ADMIN)', () => {
  it('clear chat: several phrasings', () => {
    for (const t of ['clear chat', 'clear the chat', 'reset conversation', 'wipe the messages', 'clear history']) {
      const r = parseAdminCommand(t);
      assert.equal(r.isAdmin, true, t);
      assert.equal(r.command, 'clear_chat', t);
    }
  });

  it('delete a single kind, default Ground scope', () => {
    const f = parseAdminCommand('delete all fragments on this ground');
    assert.equal(f.command, 'delete');
    assert.deepEqual(f.kinds, ['fragments']);
    assert.equal(f.scope, 'ground');
    assert.deepEqual(parseAdminCommand('delete all strategies').kinds, ['strategies']);
    assert.deepEqual(parseAdminCommand('remove all observations').kinds, ['observations']);
    assert.deepEqual(parseAdminCommand('delete all capabilities').kinds, ['fragments', 'strategies'], 'capabilities = both actionable kinds (bare Fragment + multi-step Strategy), not just strategies');
  });

  it('scope widens to all grounds on "everywhere" / "all grounds"', () => {
    assert.equal(parseAdminCommand('delete all fragments everywhere').scope, 'all');
    assert.equal(parseAdminCommand('wipe all strategies across all grounds').scope, 'all');
    assert.equal(parseAdminCommand('delete all observations on this locale').scope, 'ground');
  });

  it('multiple kinds in one command', () => {
    const r = parseAdminCommand('delete all fragments and strategies');
    assert.deepEqual(r.kinds.sort(), ['fragments', 'strategies']);
  });

  it('"everything" / "wipe the ground" → all artifact kinds', () => {
    assert.deepEqual(parseAdminCommand('delete everything').kinds.sort(), [...ADMIN_KINDS].sort());
    assert.deepEqual(parseAdminCommand('wipe the ground').kinds.sort(), [...ADMIN_KINDS].sort());
  });

  it('workflows (v2.74.811): bulk-delete recognized + GLOBAL (excluded from "everything")', () => {
    assert.deepEqual(parseAdminCommand('delete all workflows').kinds, ['workflows']);
    assert.deepEqual(parseAdminCommand('clear all workflows on this site').kinds, ['workflows']);
    assert.equal(parseAdminCommand('delete that workflow').isAdmin, false, 'singular reference is not a bulk command');
    assert.ok(!parseAdminCommand('delete everything').kinds.includes('workflows'), 'cross-Ground workflows are NOT swept by a per-Ground "everything"');
  });

  it('a SINGULAR reference is NOT a bulk command (→ corrective feedback handles "delete that")', () => {
    assert.equal(parseAdminCommand('delete that').isAdmin, false);
    assert.equal(parseAdminCommand('delete that fragment').isAdmin, false, 'singular "fragment" ≠ bulk');
    assert.equal(parseAdminCommand('remove this one').isAdmin, false);
  });

  it('an ordinary ask is not admin (the normal turn path is untouched)', () => {
    assert.equal(parseAdminCommand('search for music').isAdmin, false);
    assert.equal(parseAdminCommand('how many results are there').isAdmin, false);
    assert.equal(parseAdminCommand('').isAdmin, false);
  });
});

describe('orchAdmin — parseDedupCommand (find/merge duplicate Grounds)', () => {
  it('recognizes dedupe/consolidate phrasings (imply duplicates)', () => {
    for (const t of ['dedupe grounds', 'de-dupe my sites', 'deduplicate grounds', 'consolidate grounds', 'consolidate duplicate sites']) {
      assert.equal(parseDedupCommand(t).isDedup, true, t);
    }
  });
  it('recognizes merge/find ONLY with an explicit duplicate word', () => {
    assert.equal(parseDedupCommand('merge duplicate grounds').isDedup, true);
    assert.equal(parseDedupCommand('find duplicate sites').isDedup, true);
    assert.equal(parseDedupCommand('combine redundant grounds').isDedup, true);
    assert.equal(parseDedupCommand('merge grounds').isDedup, false, '"merge grounds" alone is ambiguous → not hijacked');
  });
  it('requires a Ground/site noun', () => {
    assert.equal(parseDedupCommand('dedupe the database').isDedup, false);
    assert.equal(parseDedupCommand('merge duplicate fragments').isDedup, false);
  });
  it('an ordinary ask / empty is not a dedup command', () => {
    assert.equal(parseDedupCommand('search jazz singer jobs on indeed').isDedup, false);
    assert.equal(parseDedupCommand('').isDedup, false);
  });
});
