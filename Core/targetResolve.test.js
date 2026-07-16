/**
 * TRT-2 (v2.74.1546) — targetResolve: the TR ladder (DESIGN_target_routing §3) + the trace line (§7.3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget, siteRefTokens, renderTargetDecision } from './targetResolve.js';
import { vocabularyFingerprint } from './groundVocabulary.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const GROUNDS = [
  { groundId: 'vs', host: 'vendorsuite.drhorton.com', name: 'Drhorton' },
  { groundId: 'zd', host: 'deako.zendesk.com', name: 'Zendesk' },
  { groundId: 'px', host: 'pixabay.com', name: 'Pixabay' },
];
const FPS = [
  { groundId: 'vs', fp: vocabularyFingerprint({ legs: [{ name: 'Warranty tasks by status', does: 'warranty tasks for a division', params: [{ name: 'divisionId', hint: 'the DIVISION' }] }], capabilities: [{ intent: 'Search ticket by division' }] }) },
  { groundId: 'zd', fp: vocabularyFingerprint({ legs: [{ name: 'Ticket history', does: 'zendesk ticket events', params: [{ name: 'requester' }] }] }) },
  { groundId: 'px', fp: vocabularyFingerprint({ legs: [{ name: 'Image search', does: 'search photos illustrations vectors', params: [{ name: 'keyword' }] }] }) },
];
const ALIASES = [{ phrase: norm('show ticket 4867009 in raleigh on vendorsuite'), groundId: 'vs', capabilityId: 'cap1' }];
const CTX = { grounds: GROUNDS, fingerprints: FPS, aliasIndex: ALIASES, normalizePhrase: norm };

describe('targetResolve — the TR ladder (TRT-2)', () => {
  it('TR-1 explicit: a named KNOWN ground is authoritative; off-desk names are visitor-flagged', () => {
    const d = resolveTarget('search light switch images on pixabay', { ...CTX, deskOrigins: ['vendorsuite.drhorton.com', 'deako.zendesk.com'] });
    assert.equal(d.tier, 'explicit'); assert.equal(d.groundId, 'px'); assert.equal(d.visitor, true);
    const d2 = resolveTarget('show ticket 123 on vendorsuite', { ...CTX, deskOrigins: ['vendorsuite.drhorton.com'] });
    assert.equal(d2.tier, 'explicit'); assert.equal(d2.groundId, 'vs'); assert.equal(d2.visitor, undefined, 'in-desk explicit is not a visitor');
  });
  it('TR-1 never mints: an unknown "on <word>" is IGNORED, not a target (falls down the ladder)', () => {
    const d = resolveTarget('open tasks on monday', { ...CTX, tabGroundId: 'zd' });
    assert.equal(d.tier, 'tab', '"monday" matches no known ground → ladder continues to the tab');
    assert.deepEqual(siteRefTokens('save it to me on the page'), [], 'stop-words never read as sites');
  });
  it('TR-2 conversation: desk affinity picks the leg-speaking ground; the fused foreach ask resolves in-desk', () => {
    const d = resolveTarget('foreach division, open new warranty tasks in a new case', { ...CTX, deskOrigins: ['vendorsuite.drhorton.com', 'deako.zendesk.com'], tabGroundId: 'px' });
    assert.equal(d.tier, 'conversation'); assert.equal(d.groundId, 'vs');
    assert.ok(d.matchedTerms.includes('division'), 'explainable: division decided it');
  });
  it('TR-2a: an exact alias WITHIN the desk keeps auto authority', () => {
    const d = resolveTarget('show ticket 4867009 in Raleigh on vendorsuite!', { ...CTX, deskOrigins: ['pixabay.com'] });
    // explicit "on vendorsuite" wins first here — so test the alias tier with a non-sited phrasing:
    const ALIAS2 = [{ phrase: norm('pull the warranty queue'), groundId: 'vs', capabilityId: 'cap2' }];
    const d2 = resolveTarget('pull the warranty queue', { ...CTX, aliasIndex: ALIAS2, deskOrigins: ['vendorsuite.drhorton.com'] });
    assert.equal(d2.tier, 'alias'); assert.equal(d2.auto, true); assert.equal(d2.why, 'alias-in-desk');
    assert.equal(d.tier, 'explicit', 'a sited phrase stays TR-1');
  });
  it('TR-3 global alias: taught phrase runs where taught (auto), visitor when off-desk', () => {
    const ALIAS2 = [{ phrase: norm('pull the warranty queue'), groundId: 'vs', capabilityId: 'cap2' }];
    const d = resolveTarget('pull the warranty queue', { ...CTX, aliasIndex: ALIAS2, deskOrigins: ['deako.zendesk.com'] });
    assert.equal(d.tier, 'alias'); assert.equal(d.groundId, 'vs'); assert.equal(d.auto, true); assert.equal(d.visitor, true);
  });
  it('TR-4 tab claims when nothing stronger, logging the affinity dissent', () => {
    const d = resolveTarget('how many new warranty tasks in the division', { ...CTX, tabGroundId: 'px' });
    assert.equal(d.tier, 'tab'); assert.equal(d.groundId, 'px');
    assert.equal(d.altAffinity.groundId, 'vs', 'the disagreement is logged, not enforced (shadow insight)');
  });
  it('TR-5 live sessions rank by affinity; TR-6 global; ambiguity → candidates, never a guess', () => {
    const d5 = resolveTarget('list warranty tasks for the division', { ...CTX, liveOrigins: ['vendorsuite.drhorton.com', 'pixabay.com'] });
    assert.equal(d5.tier, 'live'); assert.equal(d5.groundId, 'vs');
    const d6 = resolveTarget('who is the requester', CTX);
    assert.equal(d6.tier, 'global'); assert.equal(d6.groundId, 'zd');
    const amb = resolveTarget('ticket', CTX);   // "ticket" collides vs/zd → equal scores
    assert.equal(amb.tier, 'global'); assert.ok(Array.isArray(amb.candidates) && amb.candidates.length >= 2, 'collision → the user picks');
  });
  it('TR-7 teach when no ground speaks the ask', () => {
    const d = resolveTarget('fold the laundry', CTX);
    assert.equal(d.tier, 'teach'); assert.equal(d.tr, 7);
  });
  it('renderTargetDecision: one explainable line, shadow-taggable', () => {
    const d = resolveTarget('foreach division, open new warranty tasks in a new case', { ...CTX, deskOrigins: ['vendorsuite.drhorton.com'] });
    const line = renderTargetDecision(d, { shadow: true });
    assert.ok(line.startsWith('TARGET ▸ (shadow) tier=TR-2/conversation'));
    assert.ok(line.includes('vendorsuite.drhorton.com') && line.includes('division'));
  });
});
