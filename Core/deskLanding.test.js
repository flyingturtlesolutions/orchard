// Core/deskLanding.test.js — DL-1 (v2.74.1600): the desk launch page assembles from PROVEN sources only.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDeskLanding, LANDING_MAX_CARDS, LANDING_MAX_WORKFLOWS } from './deskLanding.js';

const WF = (over) => ({ id: 'w1', appId: 'inst-1', name: 'Morning sweep', ask: 'sweep my queue', subAsks: ['a', 'b', 'c'], runs: 4, at: 100, ...over });
const AL = (ask, host, at = 50) => ({ ask, host, at });

describe('deskLanding — buildDeskLanding (the launch page is proven-only)', () => {
  it('welcome head: name + role message + description sub; empty desk gets the honest just-ask message, zero cards', () => {
    const s = buildDeskLanding({ title: 'Warranty', description: 'Work your warranty queue across four systems.' });
    assert.equal(s.heading, 'Warranty');
    assert.equal(s.sub, 'Work your warranty queue across four systems.');
    assert.equal(s.cards.length, 0);
    assert.match(s.message, /Nothing proven here yet/);
    assert.equal(s.vitalsAfter, false);
    assert.equal(buildDeskLanding({}).heading, 'This desk');
    assert.equal(buildDeskLanding({ description: '  ' }).sub, null);
  });
  it('saved workflows lead, most-used first, capped, carrying the record for the chain runner', () => {
    const wfs = [WF({ id: 'a', runs: 1 }), WF({ id: 'b', runs: 9, name: 'Big one' }), WF({ id: 'c', runs: 3 }), WF({ id: 'd', runs: 2 }), WF({ id: 'e', runs: 5 })];
    const s = buildDeskLanding({ title: 'X', workflows: wfs });
    assert.equal(s.cards.length, LANDING_MAX_WORKFLOWS);
    assert.equal(s.cards[0].kind, 'workflow');
    assert.equal(s.cards[0].title, 'Big one');
    assert.equal(s.cards[0].wf.id, 'b', 'the record rides the card — the panel replays it verbatim');
    assert.match(s.cards[0].sub, /3 steps · run 9×/);
    assert.match(s.message, /run a proven action/);
  });
  it('tested asks fill after workflows — VERBATIM from the ledger, desk-host-scoped, deduped, capped at 6 total', () => {
    const aliases = [
      AL('show open warranty tasks', 'vendorsuite.drhorton.com', 90),
      AL('get my zendesk tickets', 'deako.zendesk.com', 80),
      AL('sweep my queue', 'vendorsuite.drhorton.com', 70),        // dup of the workflow ask → dropped
      AL('find a shopify customer', 'admin.shopify.com', 60),       // off-desk host → dropped
      AL('Show OPEN warranty tasks', 'vendorsuite.drhorton.com', 55),// case-dup → dropped
    ];
    const s = buildDeskLanding({ title: 'X', workflows: [WF()], aliases, deskHosts: ['vendorsuite.drhorton.com', 'https://deako.zendesk.com/'] });
    const askCards = s.cards.filter((c) => c.kind === 'ask');
    assert.deepEqual(askCards.map((c) => c.ask), ['show open warranty tasks', 'get my zendesk tickets']);
    for (const c of askCards) assert.ok(aliases.some((a) => a.ask === c.ask), 'no invention — every ask card exists in the input ledger');
    assert.ok(s.cards.length <= LANDING_MAX_CARDS);
    // an unconfigured desk (no hosts) takes the newest regardless of host
    const open = buildDeskLanding({ title: 'Y', aliases: [AL('anything', 'x.com', 1)] });
    assert.equal(open.cards.length, 1);
  });
  it('the Admin desk: asks capped to leave room, the three operator commands appended, vitals AFTER the cards', () => {
    const aliases = Array.from({ length: 8 }, (_, i) => AL(`ask ${i}`, 'deako.zendesk.com', 100 - i));
    const s = buildDeskLanding({ title: 'Admin desk', isAdmin: true, aliases, deskHosts: [] });
    assert.equal(s.vitalsAfter, true, 'the panel renders its vitals card BELOW the action cards');
    const cmds = s.cards.filter((c) => c.kind === 'command');
    assert.deepEqual(cmds.map((c) => c.command), ['show dashboard', 'check-now', 'keepalive']);
    assert.equal(s.cards.filter((c) => c.kind === 'ask').length, 3, 'asks capped at 3 so the commands always fit');
    assert.equal(s.cards[s.cards.length - 1].command, 'keepalive', 'commands close the list — vitals comes after');
    assert.match(s.message, /operations console/);
  });
});
