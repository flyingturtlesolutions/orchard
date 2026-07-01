// Core/legAvailability.test.js — v2.74.1304: per-site leg assessment (Drive / Ride / Broker — which work + why).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assessLegAvailability } from './legAvailability.js';

describe('assessLegAvailability — which legs work for a site', () => {
  it('clean REST app (grounded + a fillable write, no broker) → ride available + recommended', () => {
    const v = assessLegAvailability({
      ground: { readiness: 'rich', landmarkStability: 0.9 },
      ride: { recipes: [{ method: 'GET', params: [] }, { method: 'POST', params: [{ name: 'title' }] }], tokenCaptured: true },
      broker: {},
    });
    assert.equal(v.drive.status, 'available');
    assert.equal(v.ride.status, 'available');
    assert.equal(v.broker.status, 'none');
    assert.equal(v.recommended, 'ride');            // ride (API, no DOM) preferred over drive when both work
  });

  it('Google-class app: obfuscated DOM + only hollow writes + no broker → BOTH client legs degraded', () => {
    const v = assessLegAvailability({
      ground: { readiness: 'capable', landmarkStability: 0.2 },
      ride: { recipes: [{ method: 'POST', params: [] }, { method: 'POST', params: [] }], tokenCaptured: true },
      broker: {},
    });
    assert.equal(v.drive.status, 'degraded');       // obfuscated/positional selectors
    assert.equal(v.ride.status, 'degraded');        // recipes captured but none fillable (binary/protobuf)
    assert.equal(v.broker.status, 'none');
    assert.match(v.ride.reason, /binary|opaque|gRPC/i);
  });

  it('a connected official API → broker available + recommended (beats the client legs)', () => {
    const v = assessLegAvailability({
      ground: { readiness: 'rich', landmarkStability: 0.9 },
      ride: { recipes: [{ method: 'GET', params: [] }] },
      broker: { connector: 'google-calendar' },
    });
    assert.equal(v.broker.status, 'available');
    assert.equal(v.recommended, 'broker');
  });

  it('ungrounded, no recipes, no broker → all none, recommended null', () => {
    const v = assessLegAvailability({});
    assert.equal(v.drive.status, 'none');
    assert.equal(v.ride.status, 'none');
    assert.equal(v.broker.status, 'none');
    assert.equal(v.recommended, null);
  });

  it('reads exist but no session token captured → ride degraded (arm Forage)', () => {
    const v = assessLegAvailability({ ride: { recipes: [{ method: 'GET', params: [] }], tokenCaptured: false } });
    assert.equal(v.ride.status, 'degraded');
    assert.match(v.ride.reason, /token|Forage/i);
  });
});
