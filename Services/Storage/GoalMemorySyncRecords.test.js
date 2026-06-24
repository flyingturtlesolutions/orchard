// Services/Storage/GoalMemorySyncRecords.test.js — AL-3 (v2.74.1192): the goal-memory sync envelope + cloud path.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GOAL_MEMORY_SCHEMA, goalMemoryStorageKey, goalMemorySyncRecord } from './GoalMemorySyncRecords.js';
import { logicalPathForRecord, recordMetaFromPath, SYNCABLE_KINDS } from './StoragePaths.js';

describe('GoalMemorySyncRecords — envelope', () => {
  it('storage key is per-app', () => {
    assert.equal(goalMemoryStorageKey('inbox'), 'goalMemory:inbox');
  });
  it('builds a cloud-ready envelope (id + schemaVersion + items + updatedAt + lifecycle)', () => {
    const rec = goalMemorySyncRecord('inbox', { items: [{ id: 'gm-1', kind: 'belief', body: 'x' }], updatedAt: 123 });
    assert.equal(rec.id, 'inbox');
    assert.equal(rec.appId, 'inbox');
    assert.equal(rec.schemaVersion, GOAL_MEMORY_SCHEMA);
    assert.equal(rec.items.length, 1);
    assert.equal(rec.updatedAt, 123);
    assert.equal(rec.lifecycle, 'active');
  });
  it('garbage input → an empty, well-formed record', () => {
    const rec = goalMemorySyncRecord('x', null);
    assert.deepEqual(rec.items, []);
    assert.equal(rec.appId, 'x');
  });
});

describe('GoalMemorySyncRecords — the registered cloud path (StoragePaths round-trip)', () => {
  it('goalMemory is a declared syncable kind', () => {
    assert.ok(SYNCABLE_KINDS.includes('goalMemory'));
  });
  it('logicalPathForRecord ↔ recordMetaFromPath round-trips by appId (outside the per-ground tree)', () => {
    const rec = goalMemorySyncRecord('inbox', { items: [] });
    const path = logicalPathForRecord('goalMemory', rec);
    assert.equal(path, 'workspace/appMemory/inbox/goalMemory.json');
    const meta = recordMetaFromPath(path);
    assert.equal(meta.kind, 'goalMemory');
    assert.equal(meta.id, 'inbox');
    assert.equal(meta.appId, 'inbox');
  });
  it('an appId with URL-unsafe chars is percent-encoded + decoded cleanly', () => {
    const path = logicalPathForRecord('goalMemory', { appId: 'user-a/b c', id: 'user-a/b c' });
    assert.equal(recordMetaFromPath(path).appId, 'user-a/b c');
  });
});
