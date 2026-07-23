/**
 * Core/promptCatalog.js — the LIVE system-prompt catalog for Studio's Docs tab. PURE. v2.74.1710.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────────────────
 * Studio's "System Prompts" list was a hand-maintained SNAPSHOT — `AnthropicService.getPromptTexts()` holds 29
 * prompt strings frozen in source, all from the discovery/profiling/walk era, and it drifted two ways: the entire
 * modern routing + per-item-pipeline + workflow prompt family was never added, and a snapshotted string can fall
 * out of sync with the builder it was copied from with nothing to catch it.
 *
 * This sources the modern family from the LIVE `Core/*Prompt.js` builders, called with placeholder args, so the
 * tab shows exactly what ships and CANNOT drift — a change to a builder is a change to the Docs tab, for free. It
 * also carries the render METADATA (label / badge / desc) alongside the text, so adding a prompt module is one
 * entry here and it appears in Studio automatically, rather than needing a second edit to a studio.js registry.
 *
 * ── PLACEHOLDER-CALL DISCIPLINE ─────────────────────────────────────────────────────────────────────────────
 * Each builder is invoked inside a try/catch with minimal example args. A builder that needs runtime context this
 * cannot supply degrades to an empty `system` (rendered as "unavailable"), never a throw — a partial live catalog
 * beats a broken tab. The example args are inert (a generic "do the thing" ask): they exercise the STATIC prompt
 * text, which is the only part a reader of the Docs tab cares about.
 */

import { buildStepsMessages } from './stepsPrompt.js';
import { buildInterpretMessages } from './interpretPrompt.js';
import { buildRouterMessages } from './routerPrompt.js';
import { buildAnswerMessages } from './answerPrompt.js';
import { buildAnswerShapeMessages } from './answerShapePrompt.js';
import { buildCanvasMessages } from './canvasPrompt.js';
import { buildFanoutSpecMessages } from './fanoutPersonaPrompt.js';
import { buildGapMessages } from './gapPrompt.js';
import { buildJudgeMessages } from './judgePrompt.js';
import { buildPresetAbstractMessages } from './presetAbstractPrompt.js';
import { buildRecipePolishMessages } from './recipePolishPrompt.js';
import { buildStepMessages } from './stepPrompt.js';
import { buildSweepReadsMessages, buildSweepProposeMessages } from './sweepPrompt.js';
import { buildWorkflowMatchMessages } from './workflowMatchPrompt.js';

// id · label · badge (matches studio.js BADGE_LABELS) · desc · build(): {system,user} | string
const _ENTRIES = [
  { id: 'decomposeSteps', label: 'Decompose — Intent → Workflow Steps', badge: 'routing',
    desc: 'Breaks a workflow request into the FEWEST steps that can each be run and approved. Core/stepsPrompt.js.',
    build: () => buildStepsMessages('get the open tasks and show each one in a new case', { host: 'example.com' }) },
  { id: 'interpretAsk', label: 'Interpret — The Front Door', badge: 'routing',
    desc: 'Decides what ONE ask is: act / navigate / a per-item clause (branch · map · fieldRead · write · case) / clarify. Core/interpretPrompt.js.',
    build: () => buildInterpretMessages('do the thing', {}) },
  { id: 'routeAsk', label: 'Route — Capability Match', badge: 'routing',
    desc: 'Scores retrieved capability candidates against an ask (the legacy deterministic router). Core/routerPrompt.js.',
    build: () => buildRouterMessages('do the thing', [], {}) },
  { id: 'answerAsk', label: 'Answer — Shape a Reply', badge: 'routing',
    desc: 'Turns a retriever into an answerer: shapes a reply from what was read (code counts, model phrases). Core/answerPrompt.js.',
    build: () => buildAnswerMessages({ ask: 'how many are open?' }) },
  { id: 'answerShape', label: 'Answer — Aggregate Shape', badge: 'routing',
    desc: 'Picks the aggregate/answer shape for an interrogator ask over structured facts. Core/answerShapePrompt.js.',
    build: () => buildAnswerShapeMessages({ ask: 'how many?' }) },
  { id: 'gapTeach', label: 'Gap — Teach Offer', badge: 'routing',
    desc: 'Frames the "I don’t have this here — show me" offer when no capability answers an ask. Core/gapPrompt.js.',
    build: () => buildGapMessages({ ask: 'do the thing' }) },
  { id: 'judgeMatch', label: 'Judge — Candidate Pick', badge: 'routing',
    desc: 'Judges which retrieved candidate best answers an ask. Core/judgePrompt.js.',
    build: () => buildJudgeMessages('do the thing', []) },
  { id: 'workflowMatch', label: 'Workflow — Recall Match', badge: 'routing',
    desc: 'Matches a new ask against saved workflows (paraphrase recall). Core/workflowMatchPrompt.js.',
    build: () => buildWorkflowMatchMessages('do the thing', []) },
  { id: 'stepReplan', label: 'Step — Re-split One Instruction', badge: 'routing',
    desc: 'The narrower second call that splits ONE step still holding more than one action. Core/stepPrompt.js.',
    build: () => buildStepMessages({}) },
  { id: 'fanoutPersona', label: 'Fan-out — Per-child Persona', badge: 'routing',
    desc: 'Derives a per-child persona/spec when a clause fans out over a list. Core/fanoutPersonaPrompt.js.',
    build: () => buildFanoutSpecMessages('research each person') },
  { id: 'composeCanvas', label: 'Canvas — Compose a View', badge: 'authoring',
    desc: 'Authors a structured CanvasSpec (a HUD / digest / editable content) for an app’s presentation tab. Core/canvasPrompt.js.',
    build: () => buildCanvasMessages('show a dashboard', {}) },
  { id: 'presetAbstract', label: 'Preset — Abstract a Rule', badge: 'authoring',
    desc: 'Abstracts an instance delta into a generalizable preset rule (the distill-up half). Core/presetAbstractPrompt.js.',
    build: () => buildPresetAbstractMessages('some rule', 'inbox') },
  { id: 'recipePolish', label: 'Recipe — Polish a Harvest', badge: 'authoring',
    desc: 'Polishes a crawl-harvested ride recipe into a named, parameterized leg. Core/recipePolishPrompt.js.',
    build: () => buildRecipePolishMessages({}) },
  { id: 'sweepReads', label: 'Sweep — Choose Reads', badge: 'observation',
    desc: 'The unattended fleet sweep’s read-selection think seam. Core/sweepPrompt.js.',
    build: () => buildSweepReadsMessages({}) },
  { id: 'sweepPropose', label: 'Sweep — Propose Actions', badge: 'observation',
    desc: 'The unattended fleet sweep’s propose-only think seam (never auto-acts). Core/sweepPrompt.js.',
    build: () => buildSweepProposeMessages({}) },
];

/**
 * The live catalog: `[{ id, label, badge, desc, system }]`. Metadata always present; `system` is the live prompt
 * text or `''` if the builder needed context we could not supply. PURE.
 */
export function livePromptCatalog() {
  const out = [];
  for (const e of _ENTRIES) {
    let system = '';
    try { const r = e.build(); system = (typeof r === 'string') ? r : ((r && typeof r.system === 'string') ? r.system : ''); }
    catch { system = ''; }
    out.push({ id: e.id, label: e.label, badge: e.badge, desc: e.desc, system });
  }
  return out;
}

/** Just the `{ id: system }` map, to merge into the legacy snapshot getPromptTexts() returns. PURE. */
export function livePromptTexts() {
  const out = {};
  for (const p of livePromptCatalog()) if (p.system) out[p.id] = p.system;
  return out;
}

/** Render metadata only (`[{ id, label, badge, desc }]`), for the Studio registry to append. PURE. */
export function livePromptMeta() {
  return livePromptCatalog().map(({ system, ...meta }) => meta);   // eslint-disable-line no-unused-vars
}
