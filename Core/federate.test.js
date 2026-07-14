// Core/federate.test.js — DK-4 (DESIGN_desks.md §6) the federated cross-site queue (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { groupIntoIssues, federateResults, issueLines, crossSiteKinds } from './federate.js';

describe('DK-4 — groupIntoIssues (union-find over shared corrKeys)', () => {
  it('links items across sources by a shared phone → one cross-site issue', () => {
    const items = [
      { source: 'Aircall', id: 'c1', subject: 'Missed call', state: 'opened', corrKeys: ['phone:4045551234'] },
      { source: 'Zendesk', id: 't1', subject: 'Dishwasher leak', state: 'open', corrKeys: ['phone:4045551234', 'email:jane@x.com'] },
    ];
    const issues = groupIntoIssues(items);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].crossSite, true);
    assert.deepEqual(issues[0].sources, ['Aircall', 'Zendesk']);
    assert.deepEqual(issues[0].corrKeys, ['email:jane@x.com', 'phone:4045551234']);   // merged + sorted
    assert.equal(issues[0].items.length, 2);
  });
  it('is TRANSITIVE: A-B share phone, B-C share email → one issue of 3', () => {
    const issues = groupIntoIssues([
      { source: 'S1', id: 'a', corrKeys: ['phone:1'] },
      { source: 'S2', id: 'b', corrKeys: ['phone:1', 'email:e'] },
      { source: 'S3', id: 'c', corrKeys: ['email:e'] },
    ]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].items.length, 3);
    assert.deepEqual(issues[0].sources, ['S1', 'S2', 'S3']);
  });
  it('an item with NO corrKeys is its own singleton issue (still surfaced, just not linked)', () => {
    const issues = groupIntoIssues([
      { source: 'S1', id: 'a', corrKeys: ['phone:1'] },
      { source: 'S1', id: 'b', corrKeys: [] },
      { source: 'S2', id: 'c', corrKeys: ['phone:1'] },
    ]);
    assert.equal(issues.length, 2);            // {a,c} cross-site + {b} singleton
    assert.equal(issues[0].crossSite, true);   // cross-site sorts first
    assert.equal(issues[0].items.length, 2);
    assert.equal(issues[1].crossSite, false);
    assert.equal(issues[1].items.length, 1);
  });
  it('same-source items sharing a key group but are NOT cross-site', () => {
    const issues = groupIntoIssues([
      { source: 'S1', id: 'a', corrKeys: ['order:1001'] },
      { source: 'S1', id: 'b', corrKeys: ['order:1001'] },
    ]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].crossSite, false);   // one source
    assert.equal(issues[0].items.length, 2);
  });
  it('deterministic ids i1..iN after sorting (cross-site → size → key); empty-safe', () => {
    assert.deepEqual(groupIntoIssues(null), []);
    assert.deepEqual(groupIntoIssues([]), []);
    const issues = groupIntoIssues([
      { source: 'S1', id: 'x', corrKeys: [] },
      { source: 'S1', id: 'a', corrKeys: ['phone:9'] },
      { source: 'S2', id: 'b', corrKeys: ['phone:9'] },
    ]);
    assert.equal(issues[0].id, 'i1');
    assert.equal(issues[0].crossSite, true);
    assert.equal(issues[1].id, 'i2');
  });
});

describe('DK-4 — federateResults (read results → issues) + issueLines + crossSiteKinds', () => {
  it('normalizes per-leg results (source = host tail of the leg key) then unions across connections', () => {
    const results = [
      { key: 'aw_open_conversations@workspace.aircall.io', value: { data: { conversations: { edges: [{ node: { id: 'c1', subject: 'Call', status: 'OPENED', contact: { phoneNumber: '14045551234' } } }] } } } },
      { key: 'search_tickets@deako.zendesk.com', value: { tickets: [{ id: 't1', subject: 'Leak', status: 'open', requester: { phone: '(404) 555-1234' } }] } },
    ];
    const { items, issues, crossSite } = federateResults(results);
    assert.equal(items.length, 2);
    assert.equal(crossSite, 1);
    assert.equal(issues[0].crossSite, true);
    assert.deepEqual(issues[0].sources, ['deako.zendesk.com', 'workspace.aircall.io']);
    assert.ok(issues[0].corrKeys.includes('phone:4045551234'));   // the +1-normalized cross-site join
  });
  it('a single-connection sweep links NOTHING → crossSite 0, issueLines empty (the no-op guarantee)', () => {
    const results = [
      { key: 'aw_open_conversations@workspace.aircall.io', value: { data: { conversations: { edges: [{ node: { id: 'c1', subject: 'A' } }, { node: { id: 'c2', subject: 'B' } }] } } } },
    ];
    const { crossSite, issues } = federateResults(results);
    assert.equal(crossSite, 0);
    assert.deepEqual(issueLines(issues), []);
  });
  it('issueLines renders only cross-site issues; crossSiteKinds lists the key types', () => {
    const issues = groupIntoIssues([
      { source: 'Aircall', id: 'c1', subject: 'Call', state: 'opened', corrKeys: ['phone:1'] },
      { source: 'Zendesk', id: 't1', subject: 'Leak', state: 'open', corrKeys: ['phone:1'] },
      { source: 'Zendesk', id: 't2', subject: 'Other', corrKeys: [] },   // singleton → not rendered
    ]);
    const lines = issueLines(issues);
    assert.equal(lines[0], 'ISSUE i1 (phone:1) — 2 items across Aircall, Zendesk:');
    assert.equal(lines.length, 3);   // header + 2 item lines; the singleton is omitted
    assert.deepEqual(crossSiteKinds(issues), ['phone']);
  });
  it('federateResults tolerates junk', () => {
    assert.deepEqual(federateResults(null), { items: [], issues: [], crossSite: 0 });
  });
});
