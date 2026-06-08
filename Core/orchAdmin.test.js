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

describe('orchAdmin — parseAdminCommand LIST (the read complement to delete)', () => {
  const list = (t) => parseAdminCommand(t);
  it('lists grounds', () => {
    for (const t of ['list grounds', 'show my sites', 'what grounds do I have', 'what sites do I have']) {
      const r = list(t); assert.equal(r.command, 'list', t); assert.equal(r.target, 'grounds', t);
    }
  });
  it('lists capabilities (incl. "what can you do")', () => {
    for (const t of ['list capabilities', 'show capabilities', 'what can you do', 'what can you do here', 'what capabilities do I have']) {
      const r = list(t); assert.equal(r.command, 'list', t); assert.equal(r.target, 'capabilities', t);
    }
  });
  it('lists workflows', () => {
    for (const t of ['list workflows', 'show my workflows', 'show saved recipes']) {
      const r = list(t); assert.equal(r.command, 'list', t); assert.equal(r.target, 'workflows', t);
    }
  });
  it('scope widens with "everywhere / all grounds"', () => {
    assert.equal(list('list capabilities everywhere').scope, 'all');
    assert.equal(list('list capabilities').scope, 'ground');
  });
  it('does NOT hijack a SEARCH or a DELETE', () => {
    assert.equal(list('what sites have jazz singer jobs').isAdmin, false, 'search, not a library list');
    assert.equal(list('delete all fragments').command, 'delete', 'delete still routes to delete');
    assert.equal(list('search pixabay for cats').isAdmin, false);
  });
});

describe('orchAdmin — parseAdminCommand rename / prune / stats', () => {
  const p = (t) => parseAdminCommand(t);
  it('rename a Ground (name from "to/as"; empty → chat prompts)', () => {
    const r = p('rename this ground to My Notion');
    assert.equal(r.command, 'rename'); assert.equal(r.target, 'ground'); assert.equal(r.name, 'My Notion');
    assert.equal(p('rename this site').name, '', 'no name → empty (chat prompts)');
    assert.equal(p('rename the fragment').isAdmin, false, 'rename needs a ground/site noun');
  });
  it('prune orphaned capabilities — incl. "remove/delete dead" (NOT a delete-all)', () => {
    assert.equal(p('prune orphaned capabilities').command, 'prune');
    assert.equal(p('clean up dead capabilities').command, 'prune');
    assert.equal(p('remove orphaned capabilities').command, 'prune', '"remove orphans" prunes, not delete-all');
    assert.equal(p('delete broken capabilities').command, 'prune');
    assert.equal(p('delete all capabilities').command, 'delete', 'no orphan word → a real delete-all');
  });
  it('stats / library overview', () => {
    assert.equal(p('stats').command, 'stats');
    assert.equal(p('library overview').command, 'stats');
    assert.equal(p('show me the cats').isAdmin, false);
  });
});
