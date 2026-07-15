// Core/appCatalog.test.js — CV-3a (v2.74.1164); OM refactor v2.74.1198 (abstract types + presets).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { builtinApps, builtinPresets, builtinApp, presetsForType, preconfiguredDesks } from './appCatalog.js';
import { appFromDefinition, normalizeAppDefinition, APP_TYPES } from './appDef.js';

describe('appCatalog — the abstract TYPES (what the gallery shows)', () => {
  it('exactly the 3 friendly abstract types, each a valid normalized def with a type + object model', () => {
    const apps = builtinApps();
    assert.deepEqual(apps.map((a) => a.id).sort(), [...APP_TYPES].sort());   // inbox / watcher / concierge
    for (const a of apps) {
      assert.ok(a.id && a.name && a.seed, `type ${a.id} missing a required field`);
      assert.deepEqual(normalizeAppDefinition(a), a);            // already normalized → idempotent
      assert.equal(a.source, 'builtin');
      assert.ok(APP_TYPES.includes(a.type), `type ${a.id} has no app type`);
      assert.ok(a.objectModel && a.objectModel.noun, `type ${a.id} has no object model`);
    }
  });
  it('the friendly names are plain-language (Inbox / Watcher / Concierge)', () => {
    assert.deepEqual(builtinApps().map((a) => a.name).sort(), ['Concierge', 'Inbox', 'Watcher']);
  });
});

describe('appCatalog — the named PRESETS (specializations of a type)', () => {
  it('every preset is valid, carries its type + a BOUND object model (concrete noun)', () => {
    const presets = builtinPresets();
    assert.ok(presets.length >= 6);
    for (const p of presets) {
      assert.ok(p.id && p.name && p.seed);
      assert.ok(APP_TYPES.includes(p.type), `preset ${p.id} missing a type`);
      assert.ok(p.objectModel && p.objectModel.noun, `preset ${p.id} missing a bound object model`);
    }
    assert.equal(builtinApp('support').objectModel.noun, 'ticket');     // inbox preset bound to tickets
    assert.equal(builtinApp('inbox-email').objectModel.noun, 'email');  // inbox preset bound to email
  });

  it('the read-only monitors stay pinned writePolicy:never; operators/executor are gated', () => {
    assert.equal(builtinApp('financial').defaultConfig.writePolicy, 'never');
    assert.equal(builtinApp('research').defaultConfig.writePolicy, 'never');
    assert.equal(builtinApp('support').defaultConfig.writePolicy, 'gated');
    assert.equal(builtinApp('shopper').defaultConfig.writePolicy, 'gated');
  });

  it('transitions are well-formed {verb,to} pairs (the postcondition source)', () => {
    const t = builtinApp('support').objectModel.transitions;
    assert.ok(t.some((x) => x.verb === 'close' && x.to === 'closed'));
  });
});

describe('appCatalog — resolution', () => {
  it('all type + preset ids are unique', () => {
    const ids = [...builtinApps(), ...builtinPresets()].map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('builtinApp resolves a type OR a preset; null on unknown/empty', () => {
    assert.equal(builtinApp('inbox').name, 'Inbox');               // a type
    assert.equal(builtinApp('support').name, 'Support');     // a preset (v1509 — descriptor + 'agent' dropped)
    assert.equal(builtinApp('nope'), null);
    assert.equal(builtinApp(''), null);
    assert.equal(builtinApp(null), null);
  });

  it('GD-3b (§8): the support preset\'s gdoc backend SURVIVES catalog normalization (the .1325 live bug)', () => {
    // builtinApp returns NORMALIZED defs — if normalizePresentation strips `backend`, the render route silently
    // falls to the tab default while the compose leg still offers (presentation truthy). This pins the seam.
    const p = builtinApp('support').presentation;
    assert.ok(p, 'support declares a presentation layer');
    assert.equal(p.backend, 'gdoc');
    assert.equal(p.title, 'Support drafts');
  });

  it('presetsForType groups presets under their abstract type', () => {
    assert.deepEqual(presetsForType('inbox').map((p) => p.id).sort(), ['call-manager', 'inbox-email', 'support', 'ticket-manager', 'warranty-manager']);   // FL-5 (v1346) fleet preset; DK-1 (v1481) warranty + call presets join the inbox type
    assert.deepEqual(presetsForType('concierge').map((p) => p.id), ['shopper']);
  });

  // FL-5 (v2.74.1346, DESIGN_app_fleet.md) — the fleet preset is pure DATA over the generic sweep harness.
  it('ticket-manager: propose-only seed, gated writes, ticket object model with merge/solve/assign transitions', () => {
    const t = builtinApp('ticket-manager');
    assert.ok(t, 'ticket-manager preset exists');
    assert.equal(t.defaultConfig.writePolicy, 'gated');
    assert.ok(/propose/i.test(t.seed), 'the seed is propose-only');
    assert.equal(t.objectModel.noun, 'ticket');
    assert.deepEqual(t.objectModel.transitions.map((x) => x.verb), ['merge', 'solve', 'assign', 'reopen']);
    assert.ok(Array.isArray(t.baseline) && t.baseline.length >= 2, 'ships baseline RULES (generalizable behavior, not facts)');
  });

  it('a builtin instantiates into a kind:app conversation with its seed copied (appFromDefinition)', () => {
    const a = appFromDefinition(builtinApp('financial'));
    assert.equal(a.kind, 'app');
    assert.equal(a.appId, 'financial');
    assert.equal(a.config.writePolicy, 'never');                   // the read-only floor carries onto the app
    assert.ok(a.seed.includes('READ ONLY'));
  });
});

describe('appCatalog — DK-1 (DESIGN_desks.md §4): a new site is an Inbox PRESET, not a new TYPE', () => {
  it('still exactly 3 TYPES — no "Warranty/Call Manager" type was introduced', () => {
    assert.deepEqual(builtinApps().map((a) => a.id).sort(), [...APP_TYPES].sort());
  });
  it('Warranty manager — inbox/operator preset bound to warranty tasks', () => {
    const w = builtinApp('warranty-manager');
    assert.ok(w && w.type === 'inbox' && w.archetype === 'operator');
    assert.equal(w.objectModel.noun, 'warranty task');
    assert.deepEqual(w.objectModel.states, ['new', 'open', 'fixed', 'closed']);
    assert.equal(w.defaultConfig.writePolicy, 'gated');
    assert.ok(w.baseline.length >= 1);
  });
  it('Call manager — inbox/operator preset bound to conversations, close transition', () => {
    const c = builtinApp('call-manager');
    assert.ok(c && c.type === 'inbox' && c.archetype === 'operator');
    assert.equal(c.objectModel.noun, 'conversation');
    assert.ok(c.objectModel.transitions.some((t) => t.verb === 'close' && t.to === 'closed'));
    assert.equal(c.defaultConfig.writePolicy, 'gated');
  });
});

describe('appCatalog — DK-6: preconfigured desks (the flat gallery — sites built in, no type level)', () => {
  it('the Warranty desk (id warranty-manager, identity kept) ships its 4 sites in order', () => {
    const w = builtinApp('warranty-manager');
    assert.equal(w.name, 'Warranty');   // v1508 — the kind badge carries 'desk'; the name drops the descriptor
    assert.deepEqual(w.sites.map((s) => s.host), ['vendorsuite.drhorton.com', 'zendesk.com', 'admin.shopify.com', 'app.hubspot.com']);
    assert.deepEqual(w.sites.map((s) => s.label), ['VendorSuite', 'Zendesk', 'Shopify', 'HubSpot']);
    assert.ok(/HubSpot/.test(w.seed) && /ONE case/.test(w.seed), 'the seed spans the homeowner’s whole record + correlation');
  });
  it('preconfiguredDesks = presets WITH sites (Support + Warranty + Call, v2.74.1509); site-less presets stay resolvable', () => {
    assert.deepEqual(preconfiguredDesks().map((d) => d.id).sort(), ['call-manager', 'support', 'warranty-manager']);
    assert.deepEqual(builtinApp('ticket-manager').sites, []);   // the clock harness stays gallery-hidden
    assert.ok(builtinApp('ticket-manager'), 'a gallery-hidden preset still resolves by id (existing instances keep working)');
  });
  it('the Support desk (v2.74.1509, id support kept) ships the support stack; the seed spans the customer record + queue hygiene', () => {
    const s = builtinApp('support');
    assert.equal(s.name, 'Support');
    assert.deepEqual(s.sites.map((x) => x.host), ['zendesk.com', 'app.hubspot.com', 'app.slack.com', 'admin.shopify.com', 'app.mezmo.com']);
    assert.ok(/Mezmo/.test(s.seed) && /ONE case/.test(s.seed) && /duplicate tickets/.test(s.seed), 'mirrors Support-agent + Queue-manager functions');
    assert.ok(/setup/.test(s.seed), 'the CS tool (no public host) joins per-instance via setup');
  });
  it('the Call desk (v2.74.1509, id call-manager kept) ships Aircall + Zendesk + Google Calendar; presence + calendar-aware call-backs', () => {
    const c = builtinApp('call-manager');
    assert.equal(c.name, 'Call');
    assert.deepEqual(c.sites.map((x) => x.host), ['workspace.aircall.io', 'zendesk.com', 'calendar.google.com']);
    assert.ok(/calendar/i.test(c.seed) && /availability/.test(c.seed) && /can’t be unsent/.test(c.seed), 'calendar call-backs + presence + the SMS confirm survive');
  });
});
