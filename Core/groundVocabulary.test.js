/**
 * TRT-1 (v2.74.1546) — groundVocabulary: derived fingerprints + distinctiveness-weighted affinity.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { vocabularyFingerprint, scoreAskAffinity, contentTokens, ORCHARD_NOUNS } from './groundVocabulary.js';

const VS_FP = vocabularyFingerprint({
  legs: [
    { name: 'Warranty tasks by status', does: 'list a division\'s warranty tasks by status (new / open / fixed / closed)', params: [{ name: 'divisionId', hint: 'the DIVISION — a name ("Atlanta West"), a market number ("210")' }, { name: 'status', enum: ['new', 'open', 'fixed', 'closed'] }] },
    { name: 'Warranty task counts', does: 'warranty task counts for a division', params: [{ name: 'divisionId' }] },
  ],
  capabilities: [
    { intent: 'Search ticket by division', aliases: ['show ticket 4867009 in raleigh on vendorsuite'], params: [{ name: 'DIVISION', vocabulary: ['Raleigh - 495', 'Greensboro - 118', 'Mobile - 223'] }, { name: 'FIND_A_TICKET_OR_TASK' }] },
  ],
  readKeys: ['TicketId', 'TaskNumber', 'ProjectName', 'ClaimNumber'],
});
const ZD_FP = vocabularyFingerprint({
  legs: [{ name: 'Ticket history', does: 'a zendesk ticket\'s events and comments', params: [{ name: 'ticketId' }, { name: 'requester', hint: 'the requester email' }] }],
  readKeys: ['TicketId', 'RequesterEmail', 'Subject'],
});
const FPS = [{ groundId: 'vs', fp: VS_FP }, { groundId: 'zd', fp: ZD_FP }];

describe('groundVocabulary — fingerprint + affinity (TRT-1, DESIGN_target_routing §4)', () => {
  it('derives terms from legs, capabilities, vocabularies, and read keys', () => {
    assert.ok(VS_FP.division, 'param name/hint terms present');
    assert.ok(VS_FP.warranty, 'leg-name terms present');
    assert.ok(VS_FP.raleigh, 'option-vocabulary VALUES are vocabulary too ("in Raleigh" implies vendorsuite)');
    assert.ok(VS_FP.ticket, 'read keys split camelCase (TicketId → ticket)');
    assert.ok(!VS_FP.case && !VS_FP.desk, 'Orchard\'s own nouns never enter a fingerprint');
  });
  it('scores the live ask to vendorsuite by its distinctive terms', () => {
    const ranked = scoreAskAffinity('foreach division, open new warranty tasks in a new case', FPS);
    assert.equal(ranked[0].groundId, 'vs');
    assert.ok(ranked[0].matchedTerms.includes('division') && ranked[0].matchedTerms.includes('warranty'), 'explainable: the terms that decided it');
    assert.ok(!ranked.some((r) => r.matchedTerms.includes('case')), 'spawn grammar ("case") never scores');
  });
  it('collisions stay honestly weak: "ticket" alone matches BOTH and decides nothing', () => {
    const ranked = scoreAskAffinity('ticket', FPS);
    assert.equal(ranked.length, 2, 'both grounds speak "ticket"');
    assert.equal(ranked[0].score, ranked[1].score, 'shared terms carry split weight — no winner from a collision');
  });
  it('distinctive beats common: "requester ticket" resolves to zendesk', () => {
    const ranked = scoreAskAffinity('who is the requester on this ticket', FPS);
    assert.equal(ranked[0].groundId, 'zd');
    assert.ok(ranked[0].matchedTerms.includes('requester'));
  });
  it('contentTokens strips grammar + Orchard nouns, singularizes, dedups', () => {
    const t = contentTokens('foreach division, open new warranty tasks in a new case');
    assert.ok(t.includes('division') && t.includes('warranty') && t.includes('task'));
    assert.ok(!t.includes('foreach') && !t.includes('each') && !t.includes('new') && !t.includes('case'));
    assert.ok(ORCHARD_NOUNS.has('case') && ORCHARD_NOUNS.has('desk'));
  });
});
