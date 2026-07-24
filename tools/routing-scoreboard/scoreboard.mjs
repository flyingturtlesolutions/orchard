#!/usr/bin/env node
/**
 * tools/routing-scoreboard/scoreboard.mjs — Rail C.1/C.2: the LIVE routing scoreboard (Stage 4, v2.74.1729).
 *
 * Spec: docs/HANDOFF_hardening_arc.md §6 · DESIGN_hardening_ladder.md §4.1/§4.2. LOCAL TOOLCHAIN — never the
 * shipped bundle (the progress-digest precedent). A SCOREBOARD, never a gate: results are watched; nothing here
 * fails a commit.
 *
 * One run = the golden-ask corpus (Core/goldenAsks.js) replayed against the LIVE model with the REAL curated
 * palette, through the REAL pipeline — buildInterpretMessages → API → parseInterpretOutput → interpret()'s
 * normalize+gate (injected think) — producing three readings: the C.1 aim score (per site + misses), the C.2
 * redirect-rate, and the C.2 calibration curve. Every run stamps ATTRIBUTION (manifest version + prompt sha +
 * model), because a score move must be blameable on OUR change vs provider drift (§6: non-negotiable).
 *
 * Honest scope (v0): scores the CONNECTOR/ride surface + the clause intents — the interpret neck this arc
 * gates. Builtin-leg asks are routed by deterministic pre-doors in chat.js (the live palette offers panel:1),
 * so they are SKIPPED here and reported as out-of-neck, never silently dropped. Taught/per-Ground legs live in
 * chrome.storage and are invisible headless — the palette here is the CURATED baseline.
 *
 * Usage:
 *   node tools/routing-scoreboard/scoreboard.mjs --dry-run          # palette + counts + prompt sha, no API
 *   node tools/routing-scoreboard/scoreboard.mjs --limit 10         # first N runnable entries
 *   node tools/routing-scoreboard/scoreboard.mjs --site vendorsuite.drhorton.com
 *   node tools/routing-scoreboard/scoreboard.mjs                    # the full runnable corpus (~66 calls)
 *
 * Config: ANTHROPIC_API_KEY via env or repo-root .env (env wins — the digest.cjs idiom). Missing key → one-line
 * warn, exit 1, nothing else attempted. Output: logs/run/scoreboard-<stamp>.json (git-ignored) + a console
 * summary. Per-call failures are fail-soft: stamped status 'error', run continues, errors excluded from rates.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { GOLDEN_ASKS } from '../../Core/goldenAsks.js';
import { CONNECTOR_RECIPES, harvestedRecipeLegs } from '../../Core/connectorRecipes.js';
import { BUILTIN_LEGS } from '../../Core/palette.js';
import { curatedRidesForConnections } from '../../Core/rideRecipe.js';
import { buildInterpretMessages, parseInterpretOutput } from '../../Core/interpretPrompt.js';
import { interpret } from '../../Core/interpret.js';
import { scoreEntry, tally, calibrationBins, summaryLines } from './score.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const warn = (s) => console.error(`scoreboard: ${s}`);

// ── args ─────────────────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRY = has('--dry-run');
const LIMIT = Number(val('--limit', 0)) || 0;
const SITE = val('--site', '');
const MODEL = val('--model', 'claude-sonnet-4-5');   // the extension's routing default (AnthropicService MODEL)
const DELAY_MS = Number(val('--delay', 250)) || 0;

// ── env (.env fills gaps; process.env wins — digest.cjs idiom) ──────────────────────────────────────────────
function loadEnv() {
  const out = Object.assign({}, process.env);
  try {
    const raw = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in out)) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env — fine */ }
  return out;
}

// ── the curated palette, headless — the SAME hop chain the extension rides (invariant #3): catalog →
// curatedRidesForConnections (seeded per-Ground records) → harvestedRecipeLegs PER HOST (hop 2 derives `app`
// from the host and applies the §18 arm gate; curated seeds are born accepted+enabled). The first draft called
// recipeToLeg directly on seeded records and got 0 legs — records carry no `app`; the dry run's leg COUNT is
// what caught it, which is why the count prints before anything spends a token. ─────────────────────────────
function buildPalette() {
  const hosts = [...new Set(CONNECTOR_RECIPES.map((r) => String(r.origin || r.appHost || '').replace(/^https?:\/\//i, '')).filter(Boolean))];
  const records = curatedRidesForConnections(hosts.map((h) => ({ origin: `https://${h}` })), CONNECTOR_RECIPES);
  const byHost = new Map();
  for (const r of records) { if (!byHost.has(r.origin)) byHost.set(r.origin, []); byHost.get(r.origin).push(r); }
  const legs = [];
  for (const [host, rr] of byHost) legs.push(...harvestedRecipeLegs(rr, { host }));
  return { hosts, legs, records: records.length };
}

// ── entry partition + site attribution ───────────────────────────────────────────────────────────────────────
const RECIPE_IDS = new Set(CONNECTOR_RECIPES.map((r) => r.id));
const BUILTIN_KEYS = new Set(BUILTIN_LEGS.map((l) => l.key));
const SITE_OF = new Map(CONNECTOR_RECIPES.map((r) => [r.id, String(r.origin || r.appHost || '').replace(/^https?:\/\//i, '') || '(unsited)']));
const WRITE_IDS = new Set(CONNECTOR_RECIPES.filter((r) => r.write).map((r) => r.id));

function partition(entries) {
  const runnable = []; const panelScoped = [];
  for (const e of entries) {
    const legId = e.expect && e.expect.legId;
    if (legId && BUILTIN_KEYS.has(legId)) { panelScoped.push(e); continue; }   // pre-door routed, out-of-neck v0
    runnable.push({ entry: e, site: legId ? (SITE_OF.get(legId) || '(unsited)') : (e.expect && e.expect.intent ? '(clause)' : '(negative)') });
  }
  return { runnable, panelScoped };
}

// ── the live call: real messages → API → real parse (temperature 0 — a scoreboard wants repeatability) ───────
async function callModel(apiKey, system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, temperature: 0, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  return (Array.isArray(j.content) && j.content[0] && j.content[0].text) || '';
}

async function main() {
  const env = loadEnv();
  const { hosts, legs } = buildPalette();
  const all = GOLDEN_ASKS;
  let { runnable, panelScoped } = partition(all);
  if (SITE) runnable = runnable.filter((r) => r.site.includes(SITE));
  if (LIMIT) runnable = runnable.slice(0, LIMIT);

  // attribution — the prompt sha covers system+palette for a CANARY ask, so palette drift moves it too
  const manifestVersion = (() => { try { return JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8')).version; } catch { return '?'; } })();
  const canary = buildInterpretMessages('canary: score the router', { retrieved: legs, primitives: [] });
  const promptSha = crypto.createHash('sha256').update(canary.system).digest('hex');
  const attribution = { manifestVersion: `v${manifestVersion}`, model: MODEL, promptSha, temperature: 0, corpusEntries: all.length, runnable: runnable.length, panelScopedSkipped: panelScoped.length, hosts, startedAt: new Date().toISOString() };

  console.log(`scoreboard ▸ palette ${legs.length} curated legs over ${hosts.length} hosts · ${runnable.length} runnable · ${panelScoped.length} builtin asks out-of-neck (pre-door routed; skipped honestly) · promptSha ${promptSha.slice(0, 12)}`);
  if (DRY) { console.log('scoreboard ▸ --dry-run: no API calls made.'); return 0; }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) { warn('ANTHROPIC_API_KEY unset (env or .env) — nothing run. --dry-run works without it.'); return 1; }

  const results = [];
  let i = 0;
  for (const { entry, site } of runnable) {
    i++;
    const expected = entry.expect ? (entry.expect.legId || `intent:${entry.expect.intent}`) : '(negative)';
    try {
      const { system, user } = buildInterpretMessages(entry.ask, { retrieved: legs, primitives: [] });
      const text = await callModel(apiKey, system, user);
      const raw = parseInterpretOutput(text);
      const decision = await interpret(entry.ask, { retrieved: legs, primitives: [] }, { think: () => raw });
      const s = scoreEntry(entry, decision, { writeIds: WRITE_IDS });
      results.push({ ask: entry.ask, site, expected, ...s, confidence: typeof decision.confidence === 'number' ? decision.confidence : null, intent: decision.intent });
      process.stdout.write(`\r${i}/${runnable.length} ${s.status === 'hit' ? '·' : s.status[0].toUpperCase()}  `);
    } catch (e) {
      results.push({ ask: entry.ask, site, expected, status: 'error', got: '(call failed)', why: String(e.message || e).slice(0, 120), confidence: null });
    }
    if (DELAY_MS) await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  process.stdout.write('\n');

  const tallies = tally(results);
  const calibration = calibrationBins(results);
  const record = { attribution, tallies, calibration, panelScoped: panelScoped.map((e) => e.ask), results };
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const outPath = path.join(REPO, 'logs', 'run', `scoreboard-${stamp}.json`);
  try { fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, JSON.stringify(record, null, 2)); } catch (e) { warn(`could not write ${outPath}: ${e.message}`); }

  for (const line of summaryLines({ tallies, calibration, results, attribution })) console.log(line);
  console.log(`scoreboard ▸ full record → ${path.relative(REPO, outPath)}`);
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => { warn(String(e && e.stack || e)); process.exit(1); });
