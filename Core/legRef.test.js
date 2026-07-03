// Core/legRef.test.js — v2.74.1342: the unified leg ref key. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { legRef } from './legRef.js';

describe('legRef — unified precedence', () => {
  it('prefers key (connector legs) over capabilityId / op / name', () => {
    assert.equal(legRef({ key: 'me.zendesk.read@deako.zendesk.com', capabilityId: 'cap_x', op: 'OPEN_URL', name: 'Read' }), 'me.zendesk.read@deako.zendesk.com');
  });
  it('falls through capabilityId → id → op → name', () => {
    assert.equal(legRef({ capabilityId: 'cap-search' }), 'cap-search');
    assert.equal(legRef({ id: 'cap-filter' }), 'cap-filter');
    assert.equal(legRef({ op: 'OPEN_URL', name: 'Open' }), 'OPEN_URL');
    assert.equal(legRef({ name: 'only-name' }), 'only-name');
  });
  it('accepts a bare string ref', () => {
    assert.equal(legRef('  cap_x  '), 'cap_x');
  });
  it('returns null for empty / non-objects', () => {
    assert.equal(legRef(null), null);
    assert.equal(legRef({}), null);
  });
});
