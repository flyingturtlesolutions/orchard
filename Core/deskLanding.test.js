// Core/deskLanding.test.js — DL-1 (v1602 page shape): greeting header · desk-describing subheader (connections
// included) · workflow cards with the "＋ Workflow" empty state · Admin commands with vitals below.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDeskLanding, descNamesConnections, LANDING_GREETING, LANDING_MAX_WORKFLOWS } from './deskLanding.js';

const WF = (over) => ({ id: 'w1', appId: 'inst-1', name: 'Morning sweep', ask: 'sweep my queue', subAsks: ['a', 'b', 'c'], runs: 4, at: 100, ...over });

describe('deskLanding — buildDeskLanding (the v1602 page shape)', () => {
  it('the header is the WELCOME greeting, never the desk name; the subheader carries name — description', () => {
    const s = buildDeskLanding({ title: 'Warranty', description: 'Work your warranty queue across VendorSuite, Zendesk, Shopify, and HubSpot — one case per homeowner.', connections: ['Drhorton Vendorsuite', 'Deako Zendesk'] });
    assert.equal(s.heading, LANDING_GREETING);
    assert.match(s.sub, /^Warranty — Work your warranty queue/);
    assert.equal(s.connections, null, 'the description already NAMES the connections — no duplicate line');
    assert.equal(s.vitalsAfter, false);
  });
  it('connections join the subheader when the description does not name them (or is absent)', () => {
    const s = buildDeskLanding({ title: 'Ops', description: 'Keep the queue moving.', connections: ['Deako Zendesk', 'Shopify'] });
    assert.equal(s.connections, 'Deako Zendesk · Shopify', 'a real second line — the description never mentions them');
    const bare = buildDeskLanding({ title: 'Ops', connections: ['Deako Zendesk'] });
    assert.equal(bare.sub, 'Ops — Connected to Deako Zendesk.');
    assert.equal(bare.connections, null, 'already IN the subheader — no second line');
    assert.equal(descNamesConnections('works the zendesk queue', ['Deako Zendesk']), true);
    assert.equal(descNamesConnections('keeps things moving', ['Deako Zendesk']), false);
  });
  it('workflow cards: run-verified records only, most-used first, capped; the record rides the card', () => {
    const wfs = [WF({ id: 'a', runs: 1 }), WF({ id: 'b', runs: 9, name: 'Big one' }), WF({ id: 'c', runs: 3 })];
    const s = buildDeskLanding({ title: 'X', workflows: wfs });
    assert.ok(s.cards.length <= LANDING_MAX_WORKFLOWS);
    assert.equal(s.cards[0].kind, 'workflow');
    assert.equal(s.cards[0].title, 'Big one');
    assert.equal(s.cards[0].wf.id, 'b', 'the record rides — the panel replays it through the chain runner verbatim');
    assert.match(s.cards[0].sub, /3 steps · run 9×/);
    assert.ok(!s.cards.some((c) => c.kind === 'new-workflow'), 'banked workflows → no ＋ card');
  });
  it('no banked workflow → exactly one ＋ Workflow card (never invented actions, never bare text)', () => {
    const s = buildDeskLanding({ title: 'Fresh', description: 'A new desk.' });
    assert.equal(s.cards.length, 1);
    assert.equal(s.cards[0].kind, 'new-workflow');
    assert.equal(s.cards[0].title, '＋ Workflow');
  });
  it('the Admin desk: the three operator commands as its cards, vitals kept BELOW, its OWN description', () => {
    const s = buildDeskLanding({ title: 'Admin desk', isAdmin: true, workflows: [WF()] });
    assert.equal(s.vitalsAfter, true);
    assert.deepEqual(s.cards.map((c) => c.command), ['show dashboard', 'check-now', 'keepalive']);
    assert.ok(!s.cards.some((c) => c.kind === 'new-workflow'), 'admin has commands — no ＋ card');
    assert.equal(s.heading, LANDING_GREETING);
    assert.equal(s.sub, 'Admin desk — watches your connections, ride health, and open cases across every connected site.', 'not a catalog desk — the builder owns its description (live: the subheader was just the name)');
    assert.match(buildDeskLanding({ isAdmin: true }).sub, /^Admin desk — watches/, 'title defaults too');
  });
});

describe('WW-1b (v2.74.1620) — drafts never reach the launch page', () => {
  it('a status:draft workflow is filtered out; ready/legacy (no status) show', () => {
    const spec = buildDeskLanding({ title: 'Warranty', description: 'd', workflows: [
      { ask: 'unfinished thing', status: 'draft', subAsks: ['a', 'b'] },
      { ask: 'proven thing', status: 'ready', subAsks: ['a', 'b'], runs: 2 },
      { ask: 'legacy thing', subAsks: ['a', 'b'] },
    ] });
    const titles = spec.cards.filter((c) => c.kind === 'workflow').map((c) => c.title);
    assert.deepEqual(titles, ['proven thing', 'legacy thing']);
  });
  it('ALL drafts → the honest ＋ Workflow card, not an empty launch page', () => {
    const spec = buildDeskLanding({ title: 'W', workflows: [{ ask: 'x', status: 'draft', subAsks: ['a', 'b'] }] });
    assert.equal(spec.cards.length, 1);
    assert.equal(spec.cards[0].kind, 'new-workflow');
  });
});
