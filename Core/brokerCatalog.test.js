// Core/brokerCatalog.test.js — CX-5a (v2.74.1305): the curated broker catalog + host→broker-leg projection, and its
// closing-the-loop integration with the leg-assessor (a Google Ground → Broker recommended). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BROKER_CATALOG, brokerConnectorForHost, brokerLegsForHost } from './brokerCatalog.js';
import { assessLegAvailability } from './legAvailability.js';

describe('brokerCatalog — brokerConnectorForHost', () => {
  it('resolves the Google Calendar / Gmail connectors by host', () => {
    assert.equal(brokerConnectorForHost('calendar.google.com')?.server, 'google-calendar');
    assert.equal(brokerConnectorForHost('mail.google.com')?.server, 'google-gmail');
  });
  it('is subdomain-suffix aware but does NOT broadly match *.google.com (distinct product = distinct server/scope)', () => {
    assert.equal(brokerConnectorForHost('www.calendar.google.com')?.server, 'google-calendar');   // suffix ok
    assert.equal(brokerConnectorForHost('docs.google.com'), null);                                 // not in catalog
    assert.equal(brokerConnectorForHost('google.com'), null);                                      // parent ≠ product host
  });
  it('returns null for an unknown host / empty input', () => {
    assert.equal(brokerConnectorForHost('example.com'), null);
    assert.equal(brokerConnectorForHost(''), null);
    assert.equal(brokerConnectorForHost(null), null);
  });
});

describe('brokerCatalog — brokerLegsForHost (projection through mcpToolToLeg)', () => {
  it('projects the Calendar tools → impl:oauth broker legs, server-namespaced', () => {
    const legs = brokerLegsForHost('calendar.google.com');
    assert.equal(legs.length, 4);
    assert.ok(legs.every((l) => l.tool.impl === 'oauth'), 'every broker leg is impl:oauth');
    assert.ok(legs.every((l) => l.domain === 'connector'));
    assert.ok(legs.every((l) => l.key.startsWith('me.google-calendar.')), 'keys are account.server.tool');
  });

  it('safety + mode follow the tool hints (curated ⇒ trusted): read→auto/ask, write→confirm/act, destructive→gated', () => {
    const legs = brokerLegsForHost('calendar.google.com');
    const byName = (n) => legs.find((l) => l.tool.name === n);
    assert.equal(byName('list_events').mode, 'ask');
    assert.equal(byName('list_events').safety, 'auto');       // trusted read drops to auto
    assert.equal(byName('create_event').mode, 'act');
    assert.equal(byName('create_event').safety, 'confirm');   // a write floors at confirm (HITL)
    assert.equal(byName('delete_event').safety, 'gated');     // destructiveHint always raises to gated
    // the write leg carries a real bindable schema (the §12 param-binding fix)
    assert.ok(byName('create_event').paramSchema.required.includes('summary'));
  });

  it('a host with no broker connector → no legs', () => {
    assert.deepEqual(brokerLegsForHost('example.com'), []);
  });

  it('the catalog is frozen (curated, not mutated at runtime)', () => {
    assert.ok(Object.isFrozen(BROKER_CATALOG));
  });
});

describe('brokerCatalog — brokerLegsForLinked (CX-5c palette gate)', () => {
  it('linked provider → legs; UNLINKED → none (a selectable-but-dead leg reads as broken)', async () => {
    const { brokerLegsForLinked } = await import('./brokerCatalog.js');
    assert.equal(brokerLegsForLinked('calendar.google.com', ['google']).length, 4);
    assert.deepEqual(brokerLegsForLinked('calendar.google.com', []), []);
    assert.deepEqual(brokerLegsForLinked('calendar.google.com', ['notion']), []);   // linked ≠ this host's provider
  });
  it('mode filter + seenKeys dedupe (the palette assembly contract)', async () => {
    const { brokerLegsForLinked } = await import('./brokerCatalog.js');
    const reads = brokerLegsForLinked('calendar.google.com', ['google'], { mode: 'ask' });
    assert.ok(reads.length >= 1);
    assert.ok(reads.every((l) => l.mode === 'ask'));
    const seen = new Set(brokerLegsForLinked('calendar.google.com', ['google']).map((l) => l.key));
    assert.deepEqual(brokerLegsForLinked('calendar.google.com', ['google'], { seenKeys: seen }), []);
  });
});

describe('brokerCatalog × legAvailability — closing the loop on a Google Ground', () => {
  it('a Google-class Ground (obfuscated DOM + binary writes) + a broker connector → Broker available + RECOMMENDED', () => {
    const connector = brokerConnectorForHost('calendar.google.com')?.server;   // 'google-calendar'
    const v = assessLegAvailability({
      ground: { readiness: 'capable', landmarkStability: 0.2 },                 // Drive degraded (positional selectors)
      ride: { recipes: [{ method: 'POST', params: [] }], tokenCaptured: true }, // Ride degraded (hollow binary write)
      broker: { connector },                                                     // ← the catalog supplies this
    });
    assert.equal(v.drive.status, 'degraded');
    assert.equal(v.ride.status, 'degraded');
    assert.equal(v.broker.status, 'available');
    assert.equal(v.recommended, 'broker');   // the Broker is the answer for a Google-class app — now actionable
  });
});
