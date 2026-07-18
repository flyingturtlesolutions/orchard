// Core/vitalsDashboard.test.js — VT-2d (v2.74.1583): the context-determined dashboard — ask parsing + the three
// pure spec builders, and the integration property that every built block SURVIVES the canvas' closed-vocabulary
// normalize (a builder emitting an unknown/short block would silently vanish at render — that drop must never
// eat dashboard content). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseDashboardAsk, ageWord, clockWord, friendlyVitalsLine, medianHealMinutes, buildAdminDashboardSpec, buildDeskDashboardSpec, buildFrontDashboardSpec } from './vitalsDashboard.js';
import { normalizeCanvasSpec } from './canvasSpec.js';

const NOW = 1750000000000;

describe('vitalsDashboard — parseDashboardAsk (the context door\'s phrase)', () => {
  it('matches the bare and dressed forms; admin/vitals qualifiers force the vitals view', () => {
    assert.deepEqual(parseDashboardAsk('show dashboard'), { explicitAdmin: false });
    assert.deepEqual(parseDashboardAsk('dashboard'), { explicitAdmin: false });
    assert.deepEqual(parseDashboardAsk('Open the dashboard'), { explicitAdmin: false });
    assert.deepEqual(parseDashboardAsk('show my dashboard  '), { explicitAdmin: false });
    assert.deepEqual(parseDashboardAsk('show admin dashboard'), { explicitAdmin: true });
    assert.deepEqual(parseDashboardAsk('display the vitals dashboard'), { explicitAdmin: true });
  });
  it('refuses near-misses — a dashboard-ish sentence must fall through to normal routing', () => {
    for (const t of ['show dashboards', 'dashboard for zendesk', 'show me the dashboard now', 'canvas', 'is the dashboard ok?']) {
      assert.equal(parseDashboardAsk(t), null, t);
    }
  });
});

describe('vitalsDashboard — ageWord + medianHealMinutes', () => {
  it('ages compactly; zero/absent = never', () => {
    assert.equal(ageWord(0, NOW), 'never');
    assert.equal(ageWord(NOW - 30e3, NOW), 'just now');
    assert.equal(ageWord(NOW - 5 * 60e3, NOW), '5m');
    assert.equal(ageWord(NOW - 3 * 3600e3, NOW), '3h');
    assert.equal(ageWord(NOW - 2 * 86400e3, NOW), '2d');
  });
  it('median over recently CLOSED incidents only; none → null (never a fake 0)', () => {
    const inc = [
      { status: 'closed', openedAt: NOW - 3600e3, closedAt: NOW - 3600e3 + 10 * 60e3 },   // 10m
      { status: 'closed', openedAt: NOW - 7200e3, closedAt: NOW - 7200e3 + 30 * 60e3 },   // 30m
      { status: 'closed', openedAt: NOW - 40 * 86400e3, closedAt: NOW - 40 * 86400e3 + 5 * 60e3 },   // outside 30d
      { status: 'open', openedAt: NOW - 600e3 },
    ];
    assert.equal(medianHealMinutes(inc, { now: NOW }), 10);
    assert.equal(medianHealMinutes([], { now: NOW }), null);
  });
});

const MODEL = {
  now: NOW,
  registry: {
    'a.test': { status: 'fresh', identityName: 'Divine M', lastVerifiedAt: NOW - 60e3 },
    'b.test': { status: 'signed-out', lastVerifiedAt: NOW - 3600e3 },
  },
  incidents: [
    { status: 'open', cls: 'presence', subject: 'b.test', title: 'b.test looks signed out', openedAt: NOW - 600e3 },
    { status: 'closed', cls: 'drift', subject: 'r1', title: '“Read X” on a.test may have changed', openedAt: NOW - 3600e3, closedAt: NOW - 3600e3 + 26 * 60e3 },
  ],
  grounds: [
    { host: 'a.test', groundId: 'g1', armed: 6, proven: 5, suspects: 0, proposals: 0, healedRecently: false, canary: true, presence: 'in', lastOkAge: '4m', tally: { total: 42, ok: 40, auth: 1, miss: 1, other: 0, rate: 40 / 42 } },
    { host: 'b.test', groundId: 'g2', armed: 3, proven: 0, suspects: 1, proposals: 1, healedRecently: false, canary: false, presence: 'out', lastOkAge: 'never', tally: { total: 0, ok: 0, auth: 0, miss: 0, other: 0, rate: null } },
  ],
  asks: [{ ask: 'get zendesk history', host: 'a.test' }],
  lastDaily: NOW - 3600e3,
  tallyAll: { total: 42, ok: 40, auth: 1, miss: 1, other: 0, rate: 40 / 42 },
  byDay: [{ day: '2025-06-14', total: 20, ok: 19 }, { day: '2025-06-15', total: 22, ok: 21 }],
  canaryHave: 1, canaryOf: 2, signedIn: 1, originCount: 2,
};

// The integration property: every block a builder emits must survive the canvas closed-vocabulary normalize.
function assertRenderable(spec) {
  const norm = normalizeCanvasSpec({ anchor: { appId: 'x' }, title: spec.title, blocks: spec.blocks });
  assert.equal(norm.blocks.length, spec.blocks.length, 'no dashboard block may be dropped by the canvas normalize');
  return norm;
}

describe('vitalsDashboard — buildAdminDashboardSpec (the full vitals view)', () => {
  it('carries metrics + trend + grounds table + presence + incidents + asks + the body-blind foot', () => {
    const spec = buildAdminDashboardSpec(MODEL);
    assert.equal(spec.title, 'Ground vitals — Admin desk');
    const ids = spec.blocks.map((b) => b.id);
    for (const id of ['m-succ', 'm-runs', 'm-inc', 'm-heal', 'm-canary', 'ch-trend', 't-grounds', 'md-presence', 'cd-incidents', 'md-asks', 'md-foot']) {
      assert.ok(ids.includes(id), `block ${id} present`);
    }
    const succ = spec.blocks.find((b) => b.id === 'm-succ');
    assert.equal(succ.value, '95%');
    assert.equal(succ.sub, '42 runs', 'tiles carry the mock’s context sub-line');
    assert.ok(succ.help && succ.help.includes('outcome funnel'), 'tiles carry the mock’s hover ⓘ');
    assert.equal(spec.blocks.find((b) => b.id === 'm-heal').value, '26m');
    assert.equal(spec.blocks.find((b) => b.id === 'm-canary').value, '1/2');
    const table = spec.blocks.find((b) => b.id === 't-grounds');
    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[0][0].text, 'a.test');
    assert.equal(table.rows[0][0].mono, true, 'hosts render mono like the mock');
    assert.equal(table.rows[0][1].dot, 'in', 'presence renders as the mock’s dot cell');
    assert.ok(table.rows[0][2].bar > 0.9 && table.rows[0][2].label === '95%', 'success renders as the mock’s bar+pct');
    assert.ok(table.rows[0].some((c) => c && c.mix && c.mix.ok === 40), 'the failure-mix bar rides the row');
    assert.ok(table.rows[1].some((c) => c && c.chip === 'drift? fix ready' && c.tone === 'danger'), 'a suspect with a proposal says so, as a chip');
    assert.ok(table.rows[1].includes('0/3'), 'armed-but-unproven is visible, never hidden');
    const cards = spec.blocks.find((b) => b.id === 'cd-incidents');
    assert.equal(cards.kind, 'cards');
    assert.equal(cards.items[0].tone, 'open');
    assert.ok(cards.items.some((c) => c.tone === 'heal'), 'a closed drift incident renders as the violet heal card');
    assertRenderable(spec);
  });
  it('no data yet → honest dashes, no trend chart, and the normalize still keeps every block', () => {
    const spec = buildAdminDashboardSpec({ now: NOW, registry: {}, incidents: [], grounds: [], asks: [], tallyAll: { total: 0, rate: null }, byDay: [], canaryHave: 0, canaryOf: 0, lastDaily: 0 });
    assert.equal(spec.blocks.find((b) => b.id === 'm-succ').value, '—');
    assert.equal(spec.blocks.find((b) => b.id === 'm-heal').value, '—');
    assert.ok(!spec.blocks.some((b) => b.id === 'ch-trend'), 'a one-day trend is noise — omitted');
    assert.ok(!spec.blocks.some((b) => b.id === 't-grounds'), 'no grounds → no empty table');
    assert.ok(spec.blocks.find((b) => b.id === 'md-foot').text.includes('No daily sweep'), 'the foot says the sweep has not run');
    assertRenderable(spec);
  });
});

describe('vitalsDashboard — buildDeskDashboardSpec (a work desk\'s slice)', () => {
  it('titles by desk, sums proven/armed, carries cases, and keeps the same table shape', () => {
    const spec = buildDeskDashboardSpec({ ...MODEL, deskName: 'Warranty desk', origins: ['a.test'], cases: { count: 7 },
      grounds: [MODEL.grounds[0]], registry: { 'a.test': MODEL.registry['a.test'] } });
    assert.equal(spec.title, 'Warranty desk — dashboard');
    assert.equal(spec.blocks.find((b) => b.id === 'm-proven').value, '5/6');
    assert.equal(spec.blocks.find((b) => b.id === 'm-cases').value, 7);
    assert.ok(spec.blocks.find((b) => b.id === 't-grounds'));
    assert.ok(!spec.blocks.some((b) => b.id === 'md-empty'));
    assertRenderable(spec);
  });
  it('a desk with no learned reads says so honestly instead of rendering an empty shell', () => {
    const spec = buildDeskDashboardSpec({ now: NOW, deskName: 'Fresh desk', origins: ['c.test'], registry: {}, incidents: [], grounds: [], asks: [], tallyAll: { total: 0, rate: null }, byDay: [], lastDaily: 0 });
    assert.ok(spec.blocks.find((b) => b.id === 'md-empty').text.includes('No learned reads'));
    assertRenderable(spec);
  });
});

describe('vitalsDashboard — buildFrontDashboardSpec (the cross-desk overview — a DIFFERENT dashboard)', () => {
  it('rosters desks with cases + recency, summarizes globally, and points at the Admin desk for the full vitals', () => {
    const spec = buildFrontDashboardSpec({ ...MODEL, desks: [
      { name: 'Warranty desk', cases: 7, updatedAt: NOW - 3600e3, pinned: true },
      { name: 'Call manager', cases: 0, updatedAt: NOW - 2 * 86400e3, pinned: false },
    ] });
    assert.equal(spec.title, 'Orchard — desks overview');
    assert.equal(spec.blocks.find((b) => b.id === 'm-desks').value, 2);
    assert.equal(spec.blocks.find((b) => b.id === 'm-conn').value, '1/2');
    const table = spec.blocks.find((b) => b.id === 't-desks');
    assert.equal(table.rows[0][0].text, 'Warranty desk');
    assert.deepEqual(table.rows[0].slice(1, 3), ['7', '1h']);
    assert.deepEqual(table.rows[0][3], { chip: 'pinned', tone: 'mute' });
    assert.equal(table.rows[1][3], '', 'unpinned renders empty, not a chip');
    assert.ok(spec.blocks.find((b) => b.id === 'md-hint').text.includes('Admin desk'));
    assert.ok(!spec.blocks.some((b) => b.id === 't-grounds'), 'the overview is the roster, not the vitals detail');
    assertRenderable(spec);
  });
});

describe('vitalsDashboard — the v1590 human-words layer (clockWord + friendlyVitalsLine)', () => {
  it('clockWord: same-day → clock; yesterday → prefixed; older → month-day', () => {
    const now = new Date(2026, 6, 17, 20, 0).getTime();
    assert.equal(clockWord(new Date(2026, 6, 17, 19, 2).getTime(), now), '7:02 PM');
    assert.equal(clockWord(new Date(2026, 6, 16, 19, 2).getTime(), now), 'yesterday 7:02 PM');
    assert.equal(clockWord(new Date(2026, 6, 10, 9, 5).getTime(), now), 'Jul 10, 9:05 AM');
  });
  it('friendlyVitalsLine: transition arrows → verbs, detector codes → plain causes, drift counts → sentences', () => {
    assert.equal(friendlyVitalsLine('fresh → signed-out (no-json-liveness)'), 'signed out (the session check failed)');
    assert.equal(friendlyVitalsLine('stale → wrong-account'), 'signed in as the wrong account');
    assert.equal(friendlyVitalsLine('signed-out → fresh'), 'signed in');
    assert.equal(friendlyVitalsLine('signed in again'), 'signed in again');
    assert.equal(friendlyVitalsLine('verified ok'), 'verified working again');
    assert.equal(friendlyVitalsLine('http-404 ×2'), 'the read came back 404 (2×)');
    assert.equal(friendlyVitalsLine('404 ×3'), 'the read came back 404 (3×)');
    assert.equal(friendlyVitalsLine('something unforeseen'), 'something unforeseen', 'unknown text passes through untouched');
  });
});
