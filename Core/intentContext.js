// Core/intentContext.js — RI-1 (v2.74.896): the INTENT-COMPOSER CONTEXT PACK. PURE.
//
// The intent menu's atomic tier (Core/intentMenu) surfaces goal LABELS — feature descriptions, not
// intents. RICH intents ("find the newest vector illustrations of X and open the top 5", "compare result
// counts across categories") are COMPOSITIONS over the substrate, and composing them well needs the whole
// Ground CURATED into one bounded context: what's taught (capabilities + their captured option vocabulary),
// what's readable (observations), what the site offers (goal catalog + coverage), the page-archetype graph
// (cross-page composition), and the composition primitives the runtime already executes (foreach / read /
// navigate / open-in-tab / cross-ground hand-off).
//
// This module BUILDS that pack deterministically (RI-2 renders it into the proposeRichIntents prompt; the
// validation gate there rejects any proposed step that doesn't cite a ref from THIS pack — the
// substrate-constrains-the-agent doctrine applied to generation). Everything is BOUNDED (the *_CAP consts)
// so the prompt cost is fixed, and ORDERED so the same substrate yields the same pack — which makes
// `intentContextFingerprint` a stable cache key for the composed intents.

import { authoringCoverage } from './select.js';
import { hashId } from './outcomes.js';

export const PACK_CAPS = Object.freeze({
  taught: 12, reads: 8, goals: 20, vocabGroups: 10, vocabOptions: 12, pages: 10, edges: 10, aliases: 2,
});

/** The composition primitives the EXECUTOR already supports — the FULL strategy-walker library
 *  (ExecutionEngine dispatches every one of these node families), so the composer plans with the whole
 *  vocabulary instead of flat action chains. Static — the composer can never invent one. */
export const COMPOSITION_PRIMITIVES = Object.freeze([
  'capability — fill + submit a taught capability with parameter values',
  'read — extract data from the page (titles, links, counts) via an observation or a read-goal',
  'foreach — iterate a result LIST, running steps for each item (bounded)',
  'sieve — FILTER a list: keep only the items matching a condition',
  'detect — BRANCH on what the page currently shows and take the fitting path',
  'loop — REPEAT steps until a condition holds (e.g. next page until exhausted)',
  'try — attempt a step with a FALLBACK when it fails',
  'open — open an item in a new background tab',
  'navigate — go to another page of this site',
  'wait — wait for the page to settle or show something',
  'handoff — feed a read value into a later step (same site or another Ground)',
]);

const _clean = (s, max = 120) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const _opts = (p) => (Array.isArray(p?.vocabulary) ? p.vocabulary : (Array.isArray(p?.options) ? p.options : [])).filter(Boolean);

/**
 * Build the bounded, deterministic context pack.
 * @param {object} [input]
 * @param {{name?:string,site?:string,url?:string}|null} [input.ground]
 * @param {Array<{url?:string,model?:object}>} [input.locales]   listLocales(groundId) entries
 * @param {{nodes?:Object,edges?:Array}|null} [input.siteMap]
 * @param {Array} [input.caps]        ACTIVE, non-orphan sgCapabilities (actions + observations + composites)
 * @param {string|null} [input.readiness]
 * @returns {object} pack — { site, taught, reads, goals, vocab, pages, edges, primitives, counts }
 */
export function buildIntentContext({ ground = null, locales = [], siteMap = null, caps = [], readiness = null } = {}) {
  const capList = Array.isArray(caps) ? caps.filter(Boolean) : [];

  // ── site identity
  let host = '';
  try { host = new URL(ground?.url || (Array.isArray(ground?.urlPatterns) ? ground.urlPatterns[0] : '') || '').hostname.replace(/^www\./, ''); } catch { /* */ }
  const site = { name: _clean(ground?.name || ground?.site || host || 'this site', 60), host, readiness: readiness || null };

  // ── taught: ACTION/composite capabilities with their captured option vocabulary (the verified values)
  const isObs = (c) => c.kind === 'observation';
  const taught = capList.filter((c) => !isObs(c) && (c.intent || c.name)).map((c) => ({
    id: c.id || null,
    intent: _clean(c.intent || c.name),
    kind: c.kind === 'composite' ? 'composite' : 'action',
    aliases: (Array.isArray(c.aliases) ? c.aliases : []).filter((a) => typeof a === 'string' && a.trim()).slice(0, PACK_CAPS.aliases).map((a) => _clean(a, 80)),
    params: (Array.isArray(c.params) ? c.params : [])
      .map((p) => (typeof p === 'string' ? { name: p } : (p || {})))
      .filter((p) => p.name)
      .map((p) => ({ name: String(p.name), options: _opts(p).slice(0, PACK_CAPS.vocabOptions).map((o) => _clean(o, 40)) })),
  })).sort((a, b) => (b.aliases.length - a.aliases.length) || a.intent.localeCompare(b.intent)).slice(0, PACK_CAPS.taught);

  // ── reads: observation capabilities — the harvestable data (the read half of any rich intent)
  const reads = capList.filter((c) => isObs(c) && (c.intent || c.name)).map((c) => ({
    id: c.id || null,
    intent: _clean(c.intent || c.name),
    outputType: c.outputType === 'list' ? 'list' : 'value',
  })).sort((a, b) => a.intent.localeCompare(b.intent)).slice(0, PACK_CAPS.reads);

  // ── goals: union across the Ground's Locales, with descriptions, coverage (GA-7) + archetype prevalence
  const goalByNorm = new Map();
  const featureLabel = (model, fid) => _clean(model?.features?.[fid]?.label || '', 40);
  const vocabFromGoals = new Map();   // goal label → option labels (a disclosure-unit's revealed choices)
  for (const entry of (Array.isArray(locales) ? locales : [])) {
    const model = entry && entry.model;
    for (const g of Object.values(model?.goals || {})) {
      if (!g || !g.label) continue;
      const label = _clean(g.label);
      const norm = label.toLowerCase();
      if (!norm) continue;
      if (!goalByNorm.has(norm)) goalByNorm.set(norm, { id: g.id || `goal:${norm}`, label, description: _clean(g.description || '', 160) });
      // A disclosure goal's achievableVia = [trigger, ...optionFeatureIds] — the option LABELS are page vocabulary.
      const via = Array.isArray(g.achievableVia) ? g.achievableVia : [];
      if (via.length > 2 && model && !vocabFromGoals.has(norm)) {
        const optLabels = via.slice(1).map((fid) => featureLabel(model, fid)).filter(Boolean).slice(0, PACK_CAPS.vocabOptions);
        if (optLabels.length >= 2) vocabFromGoals.set(norm, { param: label, options: optLabels, from: 'page options' });
      }
    }
  }
  // prevalence from the siteMap archetypes (count of modeled pages offering a same-normalized goal label)
  const prevalence = new Map();
  const nodes = siteMap && siteMap.nodes && typeof siteMap.nodes === 'object' ? siteMap.nodes : {};
  for (const node of Object.values(nodes)) {
    for (const ng of (Array.isArray(node?.goals) ? node.goals : [])) {
      const norm = _clean(typeof ng === 'string' ? ng : ng?.label).toLowerCase();
      if (norm) prevalence.set(norm, (prevalence.get(norm) || 0) + 1);
    }
  }
  const coverage = authoringCoverage([...goalByNorm.values()], capList);
  const coveredIds = new Set(coverage.authored.map((a) => a.goalId));
  const goals = [...goalByNorm.entries()].map(([norm, g]) => ({
    label: g.label, description: g.description,
    prevalence: prevalence.get(norm) || 1,
    covered: coveredIds.has(g.id),
  })).sort((a, b) => (b.prevalence - a.prevalence) || a.label.localeCompare(b.label)).slice(0, PACK_CAPS.goals);

  // ── vocab: capability option vocabularies (demo-verified) + disclosure-unit page options
  const vocab = [];
  const seenVocab = new Set();
  for (const t of taught) for (const p of t.params) {
    if (!p.options.length || seenVocab.has(p.name)) continue;
    seenVocab.add(p.name);
    vocab.push({ param: p.name, options: p.options, from: t.intent });
  }
  for (const v of vocabFromGoals.values()) {
    if (vocab.length >= PACK_CAPS.vocabGroups) break;
    if (!seenVocab.has(v.param)) { seenVocab.add(v.param); vocab.push(v); }
  }
  vocab.sort((a, b) => a.param.localeCompare(b.param));
  vocab.length = Math.min(vocab.length, PACK_CAPS.vocabGroups);

  // ── pages + edges: the archetype graph (cross-page composition surface)
  const pages = Object.entries(nodes).map(([pattern, n]) => ({
    pattern: _clean(pattern, 80),
    exemplarUrl: _clean(n?.exemplarUrl || '', 120),
    instances: Number(n?.instanceCount) || 1,
    modeled: n?.status === 'modeled' || !!n?.modeled,
  })).sort((a, b) => (Number(b.modeled) - Number(a.modeled)) || (b.instances - a.instances) || a.pattern.localeCompare(b.pattern)).slice(0, PACK_CAPS.pages);
  const edges = (Array.isArray(siteMap?.edges) ? siteMap.edges : []).map((e) => ({
    from: _clean(e?.from || e?.source || '', 60), to: _clean(e?.to || e?.target || '', 60),
  })).filter((e) => e.to).slice(0, PACK_CAPS.edges);

  return {
    site, taught, reads, goals, vocab, pages, edges,
    primitives: [...COMPOSITION_PRIMITIVES],
    counts: { taught: taught.length, reads: reads.length, goals: goals.length, goalsCovered: goals.filter((g) => g.covered).length, vocabGroups: vocab.length, pages: pages.length },
  };
}

/**
 * Render the pack into the compact, deterministic prompt block RI-2 feeds the composer. Sections are
 * omitted when empty; refs the composer must cite are the EXACT strings shown (capability intents, read
 * intents, goal labels, vocab options, page patterns).
 */
export function renderIntentContext(pack) {
  if (!pack || typeof pack !== 'object') return '';
  const L = [];
  L.push(`SITE: ${pack.site?.name || 'unknown'}${pack.site?.host ? ` (${pack.site.host})` : ''}${pack.site?.readiness ? ` — readiness: ${pack.site.readiness}` : ''}`);
  if (pack.taught?.length) {
    L.push('', 'TAUGHT CAPABILITIES (replayable now; params in CAPS):');
    for (const t of pack.taught) {
      const params = t.params.map((p) => p.options.length ? `${p.name}∈{${p.options.join('|')}}` : p.name).join(', ');
      L.push(`- ${t.intent}${params ? ` [${params}]` : ''}${t.kind === 'composite' ? ' (multi-step)' : ''}`);
    }
  }
  if (pack.reads?.length) {
    L.push('', 'READABLE DATA (observations — usable mid-intent):');
    for (const r of pack.reads) L.push(`- ${r.intent} → ${r.outputType}`);
  }
  if (pack.goals?.length) {
    L.push('', 'PAGE GOALS (✓ = already taught; others are teachable on first run):');
    for (const g of pack.goals) L.push(`- ${g.covered ? '✓ ' : ''}${g.label}${g.description ? ` — ${g.description}` : ''}${g.prevalence > 1 ? ` (${g.prevalence} pages)` : ''}`);
  }
  if (pack.vocab?.length) {
    L.push('', 'OPTION VOCABULARY (verified values — use these exact tokens):');
    for (const v of pack.vocab) L.push(`- ${v.param}: ${v.options.join(', ')}`);
  }
  if (pack.pages?.length) {
    L.push('', 'PAGE TYPES (archetypes; × = real pages of that shape):');
    for (const p of pack.pages) L.push(`- ${p.pattern}${p.instances > 1 ? ` ×${p.instances}` : ''}${p.modeled ? ' [explored]' : ''}`);
  }
  if (pack.edges?.length) {
    L.push('', 'NAVIGATION EDGES:');
    for (const e of pack.edges) L.push(`- ${e.from || '(any)'} → ${e.to}`);
  }
  if (pack.primitives?.length) {
    L.push('', 'COMPOSITION PRIMITIVES (the runtime supports exactly these):');
    for (const pr of pack.primitives) L.push(`- ${pr}`);
  }
  return L.join('\n');
}

/** Stable cache key for composed intents: same substrate → same fingerprint. */
export function intentContextFingerprint(pack) {
  return hashId(renderIntentContext(pack));
}

// ── RI-2 (v2.74.897) — the CITE-OR-REJECT gate over the composer's output ──────────────────────────────
// The LLM composes freely in user language, but every step must cite an EXACT resource from the pack or
// the whole intent is rejected (substrate-constrains-the-agent applied to GENERATION — same posture as
// pickValidGround validating the LLM's ground picks). Vocab params are value-checked against the verified
// option vocabulary; {placeholders} pass (they're the user's free-text slots). PURE.

// v2.74.900 — the FULL executor vocabulary (sieve/detect/loop/try/wait joined): orchestration kinds carry
// free-text refs; only the four GROUNDED kinds must cite the pack.
export const RICH_INTENT_STEP_KINDS = Object.freeze(['capability', 'read', 'goal', 'navigate', 'foreach', 'sieve', 'detect', 'loop', 'try', 'open', 'wait', 'handoff']);
const _GROUNDED_KINDS = new Set(['capability', 'read', 'goal', 'navigate']);
const _PLACEHOLDER_RE = /\{[^}]*\}/;

/**
 * @param {Array} proposals  the raw LLM intents ({title, ask, steps:[{kind,ref,params?}], params?})
 * @param {object} pack      the SAME pack the prompt was rendered from
 * @param {{max?:number}} [opts]
 * @returns {{intents:Array, rejected:Array<{title:string,reason:string}>}}
 */
export function validateRichIntents(proposals, pack, { max = 6 } = {}) {
  const intents = [];
  const rejected = [];
  if (!pack || typeof pack !== 'object') return { intents, rejected };
  const lc = (s) => _clean(s, 160).toLowerCase();
  const capSet = new Map((pack.taught || []).map((t) => [lc(t.intent), t]));
  const readSet = new Map((pack.reads || []).map((r) => [lc(r.intent), r]));
  const goalSet = new Map((pack.goals || []).map((g) => [lc(g.label), g]));
  const pageSet = new Set((pack.pages || []).map((p) => lc(p.pattern)));
  const vocab = new Map((pack.vocab || []).map((v) => [lc(v.param), new Set(v.options.map((o) => lc(o)))]));
  const vocabOrig = new Map((pack.vocab || []).map((v) => [lc(v.param), v.options]));
  const seenTitles = new Set();

  for (const p of (Array.isArray(proposals) ? proposals : [])) {
    if (intents.length >= max) break;
    const title = _clean(p?.title, 90);
    const ask = _clean(p?.ask, 140) || title;
    if (!title) { rejected.push({ title: '(untitled)', reason: 'missing title' }); continue; }
    if (seenTitles.has(title.toLowerCase())) { rejected.push({ title, reason: 'duplicate title' }); continue; }
    const steps = Array.isArray(p?.steps) ? p.steps : [];
    if (steps.length < 2 || steps.length > 8) { rejected.push({ title, reason: `needs 2-8 steps (got ${steps.length}) — single steps belong to the atomic tier` }); continue; }

    let reason = null;
    let grounded = 0;
    let teachable = false;
    const normSteps = [];
    const repaired = [];   // vocab repairs → surfaced as user params
    for (const s of steps) {
      let kind = typeof s?.kind === 'string' ? s.kind : '';
      // v2.74.900 — REPAIR-NOT-REJECT posture: an unknown kind drops THE STEP, never the intent (the
      // grounded floor below still guards substance).
      if (!RICH_INTENT_STEP_KINDS.includes(kind)) continue;
      const ref = _clean(s?.ref, 120);
      const extra = {};   // v2.74.906 — executable refs (capabilityId/kind) so a clicked intent can WALK its plan
      if (_GROUNDED_KINDS.has(kind)) {
        // v2.74.899 — KIND-TOLERANT grounding. The first live run rejected 10/10 intents because the model
        // filed real GOAL labels ("browse media galleries") under kind 'read' (the Ground had no taught
        // observations, so READABLE DATA was empty and the model reached for read-sounding goals). A
        // mis-FILED citation is not a hallucination: accept a ref that grounds ANYWHERE in the pack and
        // RE-KIND the step to the section it actually grounds in; reject only refs that ground NOWHERE.
        const probes = [
          ['capability', capSet.get(lc(ref)) || null],
          ['read', readSet.get(lc(ref)) || null],
          ['goal', goalSet.get(lc(ref)) || null],
          ['navigate', pageSet.has(lc(ref)) ? { pattern: ref } : null],
        ];
        const cited = probes.find(([k, h]) => k === kind && h);
        const hit = cited || probes.find(([, h]) => h);
        if (!hit && kind === 'read') {
          // v2.74.903 — an UNMATCHED read is a TEACHABLE READ, not a hallucination. Reads are taught on
          // first run by design (OBS-READ / the list-driver teach), and a fresh Ground has no observations
          // to cite PRECISELY because nothing taught them yet — the 22:06 live run rejected 8/8 perfectly
          // composed intents over descriptive read refs ("result titles and links"). Keep the model's
          // plain-language description as the ref (it seeds the teach prompt). NOT counted as grounded —
          // the floor below still demands ≥1 cited capability/goal/page, so the ACTION skeleton can never
          // hallucinate; citation strictness stays where it protects.
          teachable = true;
        } else if (!hit) {
          reason = `step cites nothing in the pack (any kind): "${ref}"`; break;
        } else {
          kind = hit[0];
          grounded++;
          if (kind === 'goal' && hit[1].covered === false) teachable = true;
          // v2.74.906 — carry the matched artifact's id so the chat-side WALK can RUN bound steps directly
          // (REPLAY/RUN_OBSERVATION) and only TEACH the genuine gaps, instead of re-comprehending the ask.
          if (kind === 'capability' && hit[1].id) extra.capabilityId = hit[1].id;
          else if (kind === 'read' && hit[1].id) { extra.capabilityId = hit[1].id; extra.capabilityKind = 'observation'; }
        }
      }
      // v2.74.900 — vocab violations REPAIR to a {placeholder} instead of rejecting: the composition is
      // sound, only the VALUE missed the verified options — hand the slot to the user (with a real example).
      const params = (s && typeof s.params === 'object' && s.params) ? { ...s.params } : null;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          const allowed = vocab.get(lc(k));
          if (allowed && typeof v === 'string' && !_PLACEHOLDER_RE.test(v) && !allowed.has(lc(v))) {
            const slot = (String(k).replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase() || 'value');
            params[k] = `{${slot}}`;
            repaired.push({ name: slot, example: _clean((vocabOrig.get(lc(k)) || [])[0] || '', 60) });
          }
        }
      }
      normSteps.push({ kind, ref, ...extra, ...(params ? { params } : {}) });
    }
    if (!reason && !grounded) reason = 'no step cites a capability/read/goal/page — orchestration alone is not an intent';
    if (!reason && normSteps.length < 2) reason = 'fewer than 2 usable steps after normalization';
    if (reason) { rejected.push({ title, reason }); continue; }

    seenTitles.add(title.toLowerCase());
    const params = [...(Array.isArray(p?.params) ? p.params : []).filter((x) => x && x.name)
      .map((x) => ({ name: _clean(x.name, 40), example: _clean(x.example, 60) })), ...repaired];
    const seenParams = new Set();
    intents.push({
      title, ask,
      steps: normSteps,
      params: params.filter((x) => !seenParams.has(x.name) && seenParams.add(x.name)).slice(0, 5),
      badge: teachable ? 'teachable' : 'ready',
    });
  }
  return { intents, rejected };
}
