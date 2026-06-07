// Core/groundDedup.test.js — pure ground-dedup tests (node --test).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractHost, siteIdentity, groundHosts, primaryHost, findDuplicateGroundGroups, planGroundMerge } from './groundDedup.js';

describe('groundDedup — extractHost', () => {
  it('strips scheme, path, query, fragment, port', () => {
    assert.equal(extractHost('https://app.notion.com/p/x?y=1#z'), 'app.notion.com');
    assert.equal(extractHost('http://localhost:8080/foo'), 'localhost');
  });
  it('accepts a bare host', () => assert.equal(extractHost('notion.so'), 'notion.so'));
  it('strips a wildcard subdomain from a urlPattern', () => {
    assert.equal(extractHost('https://*.notion.com/*'), 'notion.com');
    assert.equal(extractHost('*.example.co.uk'), 'example.co.uk');
  });
  it('lowercases + trims; empty for junk', () => {
    assert.equal(extractHost('HTTPS://APP.NOTION.COM'), 'app.notion.com');
    assert.equal(extractHost(''), '');
    assert.equal(extractHost(null), '');
  });
});

describe('groundDedup — siteIdentity', () => {
  it('the Notion case: same brand, DIFFERENT registrable (cross-TLD)', () => {
    const a = siteIdentity('https://app.notion.com/p/x');
    const b = siteIdentity('https://www.notion.so/');
    assert.equal(a.brand, 'notion');
    assert.equal(b.brand, 'notion');
    assert.equal(a.registrable, 'notion.com');
    assert.equal(b.registrable, 'notion.so');
    assert.notEqual(a.registrable, b.registrable, 'cross-TLD → eTLD+1 differs, so only brand merges them');
  });
  it('subdomain variants share a registrable domain', () => {
    assert.equal(siteIdentity('app.x.com').registrable, 'x.com');
    assert.equal(siteIdentity('www.x.com').registrable, 'x.com');
    assert.equal(siteIdentity('m.x.com').registrable, 'x.com');
  });
  it('multi-part ccTLD suffix: brand is the registration SLD, not "co"', () => {
    const r = siteIdentity('https://www.example.co.uk/path');
    assert.equal(r.brand, 'example');
    assert.equal(r.suffix, 'co.uk');
    assert.equal(r.registrable, 'example.co.uk');
  });
  it('single-label host + IPv4 → identity is the host itself', () => {
    assert.equal(siteIdentity('localhost').registrable, 'localhost');
    assert.equal(siteIdentity('http://127.0.0.1:9000/').registrable, '127.0.0.1');
  });
});

describe('groundDedup — groundHosts / primaryHost', () => {
  const g = {
    id: 'g1', url: 'https://app.notion.com/p/x',
    urlPatterns: [
      { pattern: 'https://app.notion.com/*', isPrimary: false },
      { pattern: 'https://*.notion.so/*', isPrimary: true },
    ],
  };
  it('groundHosts collects url + all pattern hosts', () => {
    assert.deepEqual(groundHosts(g).sort(), ['app.notion.com', 'notion.so']);
  });
  it('primaryHost prefers the isPrimary pattern', () => assert.equal(primaryHost(g), 'notion.so'));
  it('primaryHost falls back to url when no primary pattern', () => {
    assert.equal(primaryHost({ id: 'g2', url: 'https://indeed.com/', urlPatterns: [{ pattern: 'https://indeed.com/*' }] }), 'indeed.com');
  });
});

describe('groundDedup — findDuplicateGroundGroups', () => {
  const notionCom = { id: 'gnd_app', urlPatterns: [{ pattern: 'https://app.notion.com/*', isPrimary: true }] };
  const notionSo  = { id: 'nzhdhc',  urlPatterns: [{ pattern: 'https://www.notion.so/*', isPrimary: true }] };
  const indeed    = { id: 'gnd_in',  urlPatterns: [{ pattern: 'https://www.indeed.com/*', isPrimary: true }] };
  const xApp      = { id: 'gx_app',  urlPatterns: [{ pattern: 'https://app.acme.com/*', isPrimary: true }] };
  const xWww      = { id: 'gx_www',  urlPatterns: [{ pattern: 'https://www.acme.com/*', isPrimary: true }] };

  it('flags the two Notion Grounds as a BRAND-confidence cluster (cross-TLD)', () => {
    const groups = findDuplicateGroundGroups([notionCom, notionSo, indeed]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].confidence, 'brand');
    assert.equal(groups[0].key, 'notion');
    assert.deepEqual(groups[0].grounds.map((g) => g.id).sort(), ['gnd_app', 'nzhdhc']);
    assert.deepEqual(groups[0].registrables.sort(), ['notion.com', 'notion.so']);
  });
  it('subdomain variants → a HOST-confidence cluster (safe auto-merge)', () => {
    const groups = findDuplicateGroundGroups([xApp, xWww, indeed]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].confidence, 'host');
    assert.equal(groups[0].key, 'acme.com');
    assert.deepEqual(groups[0].grounds.map((g) => g.id).sort(), ['gx_app', 'gx_www']);
  });
  it('no duplicates → no groups; a host cluster is not double-counted as brand', () => {
    assert.deepEqual(findDuplicateGroundGroups([indeed]), []);
    const groups = findDuplicateGroundGroups([xApp, xWww]);   // same brand AND same registrable
    assert.equal(groups.length, 1, 'one cluster, not two');
    assert.equal(groups[0].confidence, 'host');
  });
});

describe('groundDedup — planGroundMerge', () => {
  it('canonical = most capabilities; unions + dedups urlPatterns; exactly one primary', () => {
    const a = { id: 'gnd_app', name: 'Notion', capabilityCount: 1, urlPatterns: [{ pattern: 'https://app.notion.com/*', isPrimary: true }] };
    const b = { id: 'nzhdhc',  name: 'notion.so', capabilityCount: 5, urlPatterns: [{ pattern: 'https://www.notion.so/*', isPrimary: true }, { pattern: 'https://app.notion.com/*', isPrimary: false }] };
    const plan = planGroundMerge([a, b]);
    assert.equal(plan.canonicalId, 'nzhdhc', 'b has more capabilities → canonical');
    assert.deepEqual(plan.absorbedIds, ['gnd_app']);
    assert.equal(plan.urlPatterns.length, 2, 'duplicate app.notion.com pattern deduped');
    assert.equal(plan.urlPatterns.filter((p) => p.isPrimary).length, 1, 'exactly one primary');
    assert.equal(plan.urlPatterns.find((p) => p.isPrimary).pattern, 'https://www.notion.so/*', "canonical's primary kept");
  });
  it('tie on capabilities → more urlPatterns, then smallest id; absorbed primary demoted', () => {
    const a = { id: 'b_id', urlPatterns: [{ pattern: 'p1', isPrimary: true }, { pattern: 'p2' }] };
    const b = { id: 'a_id', urlPatterns: [{ pattern: 'p3', isPrimary: true }] };
    const plan = planGroundMerge([b, a]);
    assert.equal(plan.canonicalId, 'b_id', 'more patterns wins the tie');
    assert.equal(plan.urlPatterns.filter((p) => p.isPrimary).length, 1);
  });
  it('fewer than 2 Grounds → null', () => {
    assert.equal(planGroundMerge([{ id: 'x' }]), null);
    assert.equal(planGroundMerge([]), null);
  });
});
