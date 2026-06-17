// Services/ConversationStore.test.js — DBR-2 (docs/DESIGN_dev_branches.md §2/§9): dev-conversation branch
// metadata round-trip + branch-name derivation + per-conversation resume target. ESM (harness loader).
//
// Node 16.15 has no global `chrome` or `crypto`, so we shim both at module-eval time (before any test body
// runs). ConversationStore touches `chrome.storage.local` only inside its methods, so setting the globals here
// is in time. The shim is a minimal in-memory promisified storage — enough for create/load/list/patchMeta.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = { randomUUID };
const _mem = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) { const ks = Array.isArray(keys) ? keys : [keys]; const o = {}; for (const k of ks) if (k in _mem) o[k] = _mem[k]; return o; },
      async set(obj) { Object.assign(_mem, obj); },
      async remove(keys) { const ks = Array.isArray(keys) ? keys : [keys]; for (const k of ks) delete _mem[k]; },
    },
  },
};

import gitOps from '../bridge/gitOps.cjs';
import { ConversationStore, deriveBranchName, devResumeSession } from './ConversationStore.js';

describe('ConversationStore — dev-conversation fields round-trip (DBR-2)', () => {
  it('create({kind:dev, ...}) stores branch/concern/sessionId/status and reloads them', async () => {
    const c = await ConversationStore.create({ title: 'Drawer fix', kind: 'dev', branch: 'dev/drawer-abc12345', concern: 'fix the drawer' });
    assert.equal(c.kind, 'dev');
    assert.equal(c.branch, 'dev/drawer-abc12345');
    assert.equal(c.concern, 'fix the drawer');
    assert.equal(c.sessionId, null);
    assert.equal(c.status, 'active');
    const loaded = await ConversationStore.load(c.id);
    assert.deepEqual(
      { branch: loaded.branch, concern: loaded.concern, sessionId: loaded.sessionId, status: loaded.status },
      { branch: 'dev/drawer-abc12345', concern: 'fix the drawer', sessionId: null, status: 'active' });
  });
  it('an agent conversation carries none of the dev fields', async () => {
    const c = await ConversationStore.create({ title: 'normal' });
    assert.equal(c.kind, 'agent');
    assert.equal('branch' in c, false);
    assert.equal('status' in c, false);
  });
  it('patchMeta updates fields, bumps updatedAt, and mirrors status into the index', async () => {
    const c = await ConversationStore.create({ title: 'merge me', kind: 'dev', branch: 'dev/x-abc12345' });
    await ConversationStore.patchMeta(c.id, { sessionId: 's-123', status: 'merged', mergeCommit: 'deadbeef' });
    const loaded = await ConversationStore.load(c.id);
    assert.equal(loaded.sessionId, 's-123');
    assert.equal(loaded.status, 'merged');
    assert.equal(loaded.mergeCommit, 'deadbeef');
    const summary = (await ConversationStore.list()).find((s) => s.id === c.id);
    assert.equal(summary.status, 'merged');   // mirrored into the index without a body load
  });
  it('patchMeta on a missing conversation is a safe no-op', async () => {
    assert.equal(await ConversationStore.patchMeta('nope-' + randomUUID(), { status: 'merged' }), null);
  });
});

describe('deriveBranchName — valid + collision-resistant (DBR-2)', () => {
  it('produces a name that passes gitOps.validateBranchName', () => {
    for (const seed of ['fix the drawer', 'Auth Refactor!!', '   ', '正体不明', 'a'.repeat(80), '---', '9lives']) {
      const name = deriveBranchName(seed);
      assert.equal(gitOps.validateBranchName(name), true, `derived "${name}" from "${seed}" must be valid`);
    }
  });
  it('two derivations from the same seed differ (collision-resistant shortid)', () => {
    assert.notEqual(deriveBranchName('same seed'), deriveBranchName('same seed'));
  });
});

describe('devResumeSession — per-conversation resume target (DBR-2)', () => {
  it('returns a dev conversation\'s own sessionId', () => {
    assert.equal(devResumeSession({ kind: 'dev', sessionId: 's-9' }), 's-9');
  });
  it('returns null for no session, a non-dev conversation, or junk', () => {
    assert.equal(devResumeSession({ kind: 'dev', sessionId: null }), null);
    assert.equal(devResumeSession({ kind: 'agent', sessionId: 's-9' }), null);
    assert.equal(devResumeSession(null), null);
  });
});
