/**
 * @file Services/AnthropicService.js
 * @description Anthropic Claude API client. Provides two modes:
 *
 *   1. generateTemplate (legacy one-shot) — kept for manual JSON paste flow.
 *   2. getNextStep — used by TemplateWalker for the recursive walk (one API
 *      live-tab walk. Each turn sends the current DOM + screenshot plus the
 *      confirmed step history, receives one step, executes it, then asks Claude
 *      whether the outcome was correct before moving on.
 *
 * API key stored in chrome.storage.local under 'settings:anthropic_key'.
 * Never transmitted anywhere other than api.anthropic.com.
 *
 * @module Services/AnthropicService
 * @author Agent HUB
 * @version 2.19.0
 */

import { Logger }          from '../Core/Logger.js';
import { SchemaValidator } from './SchemaValidator.js';
// PB-10 — intent-driven proposal: the rules block is ASSEMBLED from the intent's extracted parameters
// (shape/completeness/cardinality + must-cover fields) instead of a static minimal-roles prior.
import { deriveIntentSpec, buildProposeDirective } from '../Core/intentShape.js';
import { buildIntentSpec } from '../Core/intentSpec.js';   // SG-1 Comprehend contract (page-independent)
import { selectCandidates, rankCandidates, reconcileMatches } from '../Core/select.js';   // SG-2 Select (substrate query)
import { selectNecessaryFields, slugMatch } from '../Core/formCoverage.js';
import { CONDITION_FIELDS, getTypesByFamily } from './ConditionVocabulary.js';
// C-P3 (DD-08) — managed LLM proxy transport.
import { getCloudSettings, normalizeApiBaseUrl } from './Cloud/CloudSettings.js';
import { ensureFreshSession } from './Cloud/CloudTokenStore.js';
import { buildRouterMessages, parseRouterOutput } from '../Core/routerPrompt.js';   // R-3 — front-door router prompt (no DOM; fenced catalog)

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL             = 'claude-sonnet-4-5';
// v2.72.12 (Pass 9) — Model string for frontier-tier Observation calls.
// Opus 4.7 has 1:1 pixel mapping for vision coordinates and supports
// images up to 2576px on the long edge. Per Anthropic docs, temperature/
// top_p/top_k are NOT supported on Opus 4.7 — we omit them.
const MODEL_OBSERVATION_FRONTIER = 'claude-opus-4-7';
// v2.74.360 — Fast/cheap tier for low-stakes roles (classify, trivial
// describe, simple extract). NOTE: verify this model id against the account's
// available models before routing critical operations to it — if wrong, the
// routed calls 400. v1 routes only two harmless ops (see ROLE_MODEL_POLICY).
const MODEL_FAST        = 'claude-haiku-4-5';
const SETTINGS_KEY      = 'settings:anthropic_key';

// v2.74.154 — Per-million-token USD pricing for cost-metadata logging on
// LLM observations. Update when Anthropic changes published rates.
// Kept in this file (rather than a generic config) so the model strings
// above and the rate map below stay in lockstep — there's no scenario
// where we'd want one without the other.
const MODEL_PRICING_USD_PER_MILLION = Object.freeze({
  'claude-haiku-4-5' : { input: 1.00,  output: 5.00 },   // v2.74.360 — estimate; verify against published rates
  'claude-sonnet-4-5': { input: 3.00,  output: 15.00 },
  'claude-opus-4-7'  : { input: 15.00, output: 75.00 },
});

/**
 * Compute USD cost from token usage for a given model. Returns null if
 * the model isn't in the pricing table or usage is missing — caller
 * decides whether to log a fallback.
 *
 * @param {string} model
 * @param {{inputTokens?:number, outputTokens?:number}} usage
 * @returns {{input:number, output:number, total:number}|null}
 */
export function estimateCostUSD(model, usage) {
  const rates = MODEL_PRICING_USD_PER_MILLION[model];
  if (!rates || !usage) return null;
  const inputTokens  = Number(usage.inputTokens  ?? 0);
  const outputTokens = Number(usage.outputTokens ?? 0);
  const input  = (inputTokens  * rates.input)  / 1_000_000;
  const output = (outputTokens * rates.output) / 1_000_000;
  return { input, output, total: input + output };
}

// ─── v2.74.360 — Role→model policy (DESIGN_llm_roles.md § 4) ──────────────────
// Model becomes a resolved parameter of the call: an operation override wins,
// else the role default, else MODEL. Vision-bearing calls fall back to a
// vision-capable model (all current models are multimodal, so the guard is a
// safety net for any future text-only tier). Applies only to #call-routed
// operations — the Opus frontier + readImage build their own fetch and keep
// their own model. Defaults are conservative (everything on the proven MODEL);
// flipping a role/op to MODEL_FAST is a one-line edit once verified + measured.
const VISION_CAPABLE = new Set([MODEL, MODEL_OBSERVATION_FRONTIER, MODEL_FAST]);
const ROLE_MODEL_POLICY = Object.freeze({
  defaults: {
    propose: MODEL, resolve: MODEL, describe: MODEL,
    plan: MODEL, extract: MODEL, classify: MODEL, unclassified: MODEL,
  },
  // Per-operation overrides. v1 demonstrates the fast tier on two harmless,
  // low-stakes describe ops; the cheap roles (classify/extract) stay on MODEL
  // until the MODEL_FAST id is verified and the audit confirms quality holds.
  ops: {
    generateConversationTitle: MODEL_FAST,
    generateSampleQuestion:    MODEL_FAST,
    'route-ask':               MODEL_FAST,   // R-6 — the front-door router is a small/fast classification (DESIGN_llm_front_door.md §3.6); Haiku, not Sonnet
  },
});
function pickModelForCall(role, operation, hasVision) {
  let m = ROLE_MODEL_POLICY.ops[operation] ?? ROLE_MODEL_POLICY.defaults[role] ?? MODEL;
  if (hasVision && !VISION_CAPABLE.has(m)) m = MODEL;   // never route an image to a text-only model
  return m;
}

// ─── Analysis T3 recovery system prompt ──────────────────────────────────────
// v2.67.2 — Static framing for frontier-tier Analysis recovery. The
// per-call user message (description, operations description, contract,
// indexed input list, cache output) is composed in invokeAnalysisRecovery;
// this is just the system prompt. Surfaced in the Prompts tab via
// getPromptTexts() under id 'recoverAnalysisFromCache'.
//
// v2.67.4 — Framing B: contract is binding, description + operations are
// intent-evidence. Three signals govern recovery:
//   1. The Analysis's stated purpose (description) — author's intent.
//   2. The operations — one rule-based attempt at fulfilling that purpose,
//      possibly derived from runtime parameters that don't match input
//      data exactly.
//   3. The contract — what an acceptable result looks like.
// The model reconciles these rather than executing operations literally.
// When operations as written don't find matching items, the model uses
// the stated purpose to infer what the user most likely wanted.
//
// v2.68.0 — Confidence + rationale required alongside indices. Self-
// reported, not calibrated. Logged for observability; not used as a
// contract input or routing criterion.
//
// Output is forced via tool-use; the model returns indices into the input
// list. Engine maps back to the original element-tagged items in scope.

const ANALYSIS_RECOVERY_SYSTEM_PROMPT = `You are recovering from a failed rule-based data operation. The rule-based implementation produced output that violated the required contract.

Three things describe what the user wanted:
1. The Analysis's stated purpose — what this Analysis is for, in the author's own words.
2. The operations — one rule-based attempt at fulfilling that purpose. Operations may be derived from runtime parameters that don't match the input data exactly.
3. The contract — what an acceptable output looks like.

Treat the stated purpose and operations as the user's intent. The stated purpose is the strongest signal of what the user wanted; the operations show one concrete attempt that may be off due to parameter binding or other runtime effects. The contract defines what an acceptable result looks like.

Your job: satisfy the contract by selecting input items that align with the user's intent. When the operations as written don't find matching items, use the stated purpose to infer what the user most likely wanted, considering what's actually present in the input.

You select items by their index in the input list. Index 0 is the first item, index 1 is the second, etc. The order of indices in your response is the order of items in the output.

If after honest consideration no items can satisfy the contract, return an empty list — the contract will be re-checked, and the system handles whatever happens.

Along with your selection, return:
- A confidence value between 0 and 1 reflecting how sure you are the selection correctly fulfills the description and contract. 1 means highly confident; 0 means the input does not permit a confident answer. This is your subjective assessment, not a calibrated probability.
- A one-sentence rationale explaining how you arrived at the selection. This is especially valuable when confidence is low — explain why the answer is uncertain.

Output ONLY by calling the produce_recovered_output tool. Do not return free text.`;

// ─── Analysis T3 primary system prompt ───────────────────────────────────────
// v2.68.0 — Static framing for Analyses whose author chose Frontier as
// the primary tier (no rule-based body; the Analysis's body IS the model
// invocation). The per-call user message (name, description, pre-conditions,
// post-conditions, params, input value) is composed in
// invokeAnalysisFrontierPrimary; this is just the system prompt. Surfaced
// in the Prompts tab via getPromptTexts() under id
// 'invokeAnalysisFrontierPrimary'.
//
// This is genuinely different from the recovery prompt — there is no
// "failed attempt" being recovered from. The Analysis just runs frontier
// directly because that's what the author chose.
//
// The prompt establishes the Analysis primitive's framing (typed data
// operation defined by a contract), names the four signals (description,
// pre, post, params, input), and gives the model a process to follow when
// producing output. Output schema is open — the contract validates shape.
//
// Confidence + rationale required, same as recovery (logged-only; not
// contract-input or routing-criterion).

const ANALYSIS_FRONTIER_PRIMARY_SYSTEM_PROMPT = `You are executing an Analysis — a typed data operation defined by its author.

An Analysis transforms input data into output data according to a declarative contract. The author has provided:

- A description: what this Analysis is for, in plain language. This is the authoritative statement of intent. When in doubt, follow the description.
- Preconditions: structural facts the author guarantees about the input. You can rely on these.
- Postconditions: structural requirements on the output. Your output must satisfy all of them.
- Params: named values bound at runtime, available for substitution if referenced.
- The actual input data.

Your job: produce output that fulfills the description's intent and satisfies the postcondition contract. The output should be informed by the input data and faithful to it — do not invent data the input does not contain.

When deciding what to produce:
- Read the description first to understand what the Analysis is for.
- Read the postconditions to know what shape the output must have.
- Inspect the input data carefully.
- Produce output that the description's author would recognize as a correct fulfillment.

If after honest consideration the input does not permit any output that satisfies the contract, produce the most truthful output you can (often empty). The contract will be re-checked downstream; honest failure is better than fabricated success.

Along with your output, return:
- A confidence value between 0 and 1 reflecting how sure you are the output correctly fulfills the description and contract. 1 means highly confident; 0 means the input does not permit a confident answer. This is your subjective assessment, not a calibrated probability.
- A one-sentence rationale explaining how you arrived at the output. This is especially valuable when confidence is low — explain why the answer is uncertain.

Output ONLY by calling the produce_analysis_output tool. The tool's output field should contain your output value, shaped according to the postconditions. Do not return free text.`;

// ─── Observation T3 (frontier-tier vision) — Pass 8 reserved, Pass 9 consumed ───
//
// The frontier-tier Observation produces an image binding by:
//   1. Capturing a screenshot of the page (or target-scoped region)
//   2. Asking Claude with vision to locate a bounding box that matches
//      the Observation's name + description + (substituted) pre/post.
//   3. Cropping the screenshot to those coordinates client-side.
//   4. Binding the cropped image to scope.
//
// This system prompt is task-specific for coordinate selection — much
// more directive than the generic Analysis frontier prompt. The model
// has known failure modes (loose boxes, hallucinated regions, wrong
// instance, partial visibility) and the prompt addresses each.
//
// User content per call (Pass 9 will assemble):
//   - The Observation's name
//   - The Observation's description (authoritative intent)
//   - Shape ('image' for one region, 'image_list' for many)
//   - Substituted preconditions and postconditions
//   - Substituted params
//   - The screenshot
//
// Output via the locate_regions tool. See OBSERVATION_FRONTIER_LOCATE_TOOL.

const OBSERVATION_FRONTIER_VISION_SYSTEM_PROMPT = `You are a precise visual-region locator. You will be shown a screenshot of a web page (or a region of one) and an Observation record describing what content the author wants captured from it. Your job is to return the exact bounding box(es) of that content so the runtime can crop the screenshot to those coordinates.

This is a coordinate-extraction task, not an interpretation task. There is one correct answer per requested region. You succeed by returning coordinates that, when used to crop the screenshot, produce an image containing exactly the named content — no more, no less.

## The coordinate system

You output normalized coordinates in [0.0, 1.0]:
- x = 0.0 is the left edge of the screenshot; x = 1.0 is the right edge.
- y = 0.0 is the TOP edge; y = 1.0 is the BOTTOM edge. (top-left origin, image convention)
- Each region is a bounding box {x1, y1, x2, y2} with x1 < x2 and y1 < y2.

Coordinates are in screenshot space, not page space. If the screenshot shows only a portion of the page, your coordinates describe positions within what you can see.

## What "exact" means

The bounding box must be tight around the requested content. Tight means:
- The box's edges should sit at most a few pixels of natural padding away from the visual content's edges.
- The box must not include neighboring elements, surrounding whitespace beyond the natural padding, page chrome, or unrelated UI.
- The box must not crop into the content itself — antialiasing, shadows, and small visual flourishes that are clearly part of the element belong inside the box.

If the content has a visual frame (a card border, a button outline, a figure border), include the frame. If the content is unframed (a photo on a white page, a paragraph of text), the box is the content's own visual extent.

## Disambiguation when multiple candidates exist

If the screenshot contains multiple visual elements that could match the description, the author intended one of them. Use these tie-breakers in order:

1. The Observation's description should name a specific instance (e.g. "the main product image", "the price in the header"). Take that literally.
2. If the description is generic ("the product image") and shape is \`image\` (single), return the most prominent instance: largest area, or the one given the most visual weight (largest size, central position, top of viewport).
3. If shape is \`image_list\`, return ALL matching instances ordered top-to-bottom, then left-to-right.
4. If you cannot decide which instance the author meant and shape is \`image\` (single), return zero regions and explain in the rationale. Do not guess.

## Three possible outcomes

Your call to locate_regions falls into exactly one of three categories. Be deliberate about which.

### Outcome A — Found, fully visible

The screenshot contains content that matches the description, and the content is fully and clearly visible. No edges cut off, no overlays covering it, no loading skeletons. Return tight bounding boxes. Confidence high (typically 0.85+). Set partial_visibility to null.

### Outcome B — Found, partially visible

The screenshot contains content that matches the description, but the content is only partially visible. You can still return a bounding box describing the visible portion — that's useful — but you must flag the partial state so the runtime knows the capture is incomplete.

Cases that count as partial:

- The content extends past the screenshot's edge. Bottom-cut, top-cut, left-cut, or right-cut. Visual cue: text mid-line at the boundary, image clipped at the frame, a card or panel whose enclosing border is incomplete.
- An overlay is covering part of the content. Cases include sticky headers, sticky footers, cookie banners, chat widgets, modal dialogs, fixed-position toasts. You see two layers — the target underneath and the obstructing element on top.
- The content is in a loading or animating state. Skeleton shimmers, placeholder boxes, "Loading…" text where actual content should be, half-loaded images.
- An expander is visible suggesting more content below the visible portion ("Read more", "Show all", "See N more comments"). You can see the visible portion but the rest is hidden behind the expander.

For partial outcomes:
- Return a bounding box around what IS visible — this is still actionable for the runtime.
- Set partial_visibility with a kind, optional edge (for cut_at_edge), a brief description of the obscuring element if applicable, and a one-sentence suggestion for what the author could do (scroll, dismiss banner, wait, expand).
- Reduce confidence to reflect the incompleteness — typically 0.5–0.8 depending on how much of the target is visible.

Do NOT silently return a tight box around the visible portion as if it were the full target. The runtime needs to know the capture is incomplete.

### Outcome C — Not found

The content described is not present in this screenshot. Cases:

- The content is genuinely not on this page — wrong URL, wrong page state, the element doesn't exist in this UI.
- The content is completely obscured by an overlay (no visible portion at all). This is C, not B — B requires that some part of the target be visible.
- Multiple candidates exist and the description does not disambiguate which one. (Single-image shape only — for image_list, return all candidates.)
- The screenshot shows an error state, blank page, or page that has not loaded.

For not-found outcomes:
- Return an empty regions list.
- Set confidence based on certainty: high (0.8+) if you're confident the content is not present; low (below 0.4) if you're unsure whether you missed it.
- Write a rationale that explains why no region was returned: "page shows a 404", "no element matching the description visible in this view", "two product images of equal prominence — description doesn't specify which".
- Set partial_visibility to null.

## Calibration of confidence

- 0.95+: I can point precisely at one region whose visual extent unambiguously matches the description; no other candidates compete.
- 0.7–0.95: One clear candidate, but minor ambiguity in where the box edges should sit, or minor visual clutter at the boundaries.
- 0.4–0.7: Multiple candidates and the description's tie-breaker resolved one, but a different reading of the description could pick a different region.
- below 0.4: I'm unsure either the region exists or where its boundaries are. Strongly consider returning empty regions instead.

## What "useful" rationale looks like

Whether the outcome is A, B, or C, write a rationale that helps the author act if the result is wrong.

Useful (concrete and actionable):
- "Selected the larger of two product images based on visual prominence; the smaller image at top-right is also a candidate."
- "Bottom of the article paragraph extends past the viewport — about 40% of the text is below the fold."
- "A cookie consent banner covers the bottom ~80px of the target footer."
- "Two pricing cards visible; description says 'the highlighted one' but neither has a visual highlight in this screenshot."

Not useful (vague or just acknowledging the problem):
- "Image is partially cut off."
- "I see the element."
- "The content is unclear."
- "Multiple options exist."

The rationale is the author's debugging signal when the strategy doesn't behave as expected. Aim to give them one concrete thing they could do next.

## How to proceed

1. Read the description first. Note any specific phrasing that disambiguates: "the main", "the first", "above the fold", "in the header", "below the title".
2. Inspect the screenshot. Identify candidate regions.
3. Apply the tie-breakers if multiple candidates exist.
4. Determine outcome category (A/B/C). For B, identify the partial_visibility kind and craft a useful suggestion.
5. For each region you select, mentally verify: does the box's content match the description, and does the box exclude everything else? Adjust the edges if needed.
6. Return your output via the locate_regions tool. Set confidence per the calibration scale. Write a rationale that explains which region you chose and why (especially valuable if confidence is below 0.95 or partial_visibility is set).

Output ONLY by calling locate_regions. Do not return free text.`;

const OBSERVATION_FRONTIER_LOCATE_TOOL = {
  name: 'locate_regions',
  description: 'Return bounding box coordinates for the content described in the Observation, or an empty list if the content is not present in the screenshot.',
  input_schema: {
    type: 'object',
    properties: {
      regions: {
        type: 'array',
        description: 'One bounding box per matched region. Empty if the content is not present (Outcome C). For shape=image, at most one region; for shape=image_list, ordered top-to-bottom then left-to-right.',
        items: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              description: 'Short descriptive label for this region (used as the captured image\'s alt text).',
            },
            x1: { type: 'number', minimum: 0, maximum: 1, description: 'Left edge in normalized [0,1] coordinates. Top-left origin.' },
            y1: { type: 'number', minimum: 0, maximum: 1, description: 'Top edge in normalized [0,1] coordinates. Top-left origin.' },
            x2: { type: 'number', minimum: 0, maximum: 1, description: 'Right edge. Must be greater than x1.' },
            y2: { type: 'number', minimum: 0, maximum: 1, description: 'Bottom edge. Must be greater than y1.' },
          },
          required: ['label', 'x1', 'y1', 'x2', 'y2'],
        },
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Subjective certainty that the regions returned match the description. See calibration scale in the system prompt.',
      },
      rationale: {
        type: 'string',
        description: 'One sentence explaining the selection, disambiguation applied, or reason for empty output.',
      },
      partial_visibility: {
        type: ['object', 'null'],
        description: 'Set when matched content is only partially visible (Outcome B). Null otherwise.',
        properties: {
          kind: {
            type: 'string',
            enum: ['cut_at_edge', 'covered_by_overlay', 'loading_state', 'expander_hidden', 'unknown'],
            description: 'How the content is partially visible.',
          },
          edge: {
            type: ['string', 'null'],
            enum: ['top', 'bottom', 'left', 'right', null],
            description: 'For cut_at_edge: which edge cuts the content. Null for other kinds.',
          },
          obscuring_element: {
            type: ['string', 'null'],
            description: 'For covered_by_overlay: brief description of what is covering the target (e.g. "cookie consent banner", "sticky header"). Null for other kinds.',
          },
          suggestion: {
            type: 'string',
            description: 'One-sentence qualitative hint (no specific pixel counts): direction and rough magnitude. Examples: "scroll down significantly to reveal the rest", "dismiss the cookie banner at the bottom of the screen", "wait for the image to finish loading", "click the Read more button to expand the content".',
          },
        },
        required: ['kind', 'suggestion'],
      },
    },
    required: ['regions', 'confidence', 'rationale', 'partial_visibility'],
  },
};

// ─── UI type navigation hints (Phase 1) ──────────────────────────────────────
// Injected into the Phase 1 system prompt to tell Claude what the entry point
// looks like and what to expect after clicking it. Eliminates exploratory turns.

const UI_TYPE_NAV_HINTS = {
  chat_widget: `NAVIGATION CONTEXT — Chat Widget:
The AI entry point is a button in the toolbar or header (look for aria-label containing "Assistant", "Copilot", or an alias).
STEP 1: CLICK the entry point button.
STEP 2: That is all. Your phase is complete after the CLICK.
Do NOT add WAIT_FOR steps — the system detects the panel and input automatically.
Do NOT click the button again if you already clicked it — clicking it again will CLOSE the panel.
After your first successful CLICK, return WAIT with value "1000" if unsure what to do next.`,

  sidebar_drawer: `NAVIGATION CONTEXT — Sidebar Drawer:
The AI entry point opens a side panel in the SAME FRAME — no iframe involved.
After clicking, WAIT_FOR the textarea or input to appear, then your phase is complete.`,

  inline_embedded: `NAVIGATION CONTEXT — Inline Embedded:
The AI input is ALREADY VISIBLE in the current page — no entry point click needed.
Use FIND_AI to locate and confirm the input directly.`,

  modal_dialog: `NAVIGATION CONTEXT — Modal Dialog:
The AI entry point opens a dialog in the SAME FRAME — no iframe.
After clicking, WAIT_FOR the input inside the modal, then your phase is complete.`,

  topbar_overlay: `NAVIGATION CONTEXT — Top-bar Overlay:
The AI entry point is a toolbar button that opens a popover in the SAME FRAME.
After clicking, WAIT_FOR the input in the popover, then your phase is complete.`,
};

/**
 * Maximum iframe recursion depth per UI type for discoverDeepestFrame.
 * chat_widget: 1 — stop at first iframe tier, don't recurse into decorative children.
 * others: 0 — no iframe expected, skip frame discovery entirely.
 */
const UI_TYPE_IFRAME_DEPTH = {
  chat_widget    : 1,
  sidebar_drawer : 0,
  inline_embedded: 0,
  modal_dialog   : 0,
  topbar_overlay : 0,
};

// ─── UI implementation type → DOM shape descriptions (Phase 2) ───────────────
// Injected into the Phase 2 system prompt to tell Claude what DOM structure
// to expect inside the open panel. Each description covers: input element
// type, send button location, and response container shape.

const UI_TYPE_SHAPES = {
  chat_widget: `DOM SHAPE — Chat Widget (iframe-hosted floating panel):
- Input: contenteditable div, often [data-test-id*="input"] or [role="textbox"] or div.ProseMirror
- Send: icon button directly adjacent to the input, often [data-test-id*="send"] or button[aria-label*="send"]
- Response: sequential sibling elements, e.g. [data-test-id*="message"] or [data-test-id*="chat"] repeated per message
- The input may require clicking first to focus before typing`,

  sidebar_drawer: `DOM SHAPE — Sidebar Drawer (full-height side panel):
- Input: textarea or contenteditable div at the bottom of the panel
- Send: button below or beside the input, often primary/submit styled
- Response: scrollable message list above the input, repeated container elements per message
- Panel is in the main document frame or a same-origin iframe`,

  inline_embedded: `DOM SHAPE — Inline Embedded (always-visible in page content):
- No panel open step needed — the input is present in the current DOM
- Input: textarea or contenteditable div within the page content area
- Send: button adjacent to the input or triggered by Enter key — look for a submit button
- Response: appears directly below the input or replaces nearby content`,

  modal_dialog: `DOM SHAPE — Modal Dialog (centered overlay):
- Input: textarea or input[type="text"] inside the dialog container
- Send: primary action button (often labelled "Send", "Submit", "Ask") inside the dialog
- Response: appears in the dialog body above the input in a scrollable area
- Dialog container: [role="dialog"], .modal, [aria-modal="true"]`,

  topbar_overlay: `DOM SHAPE — Top-bar Overlay (dropdown/popover from header):
- Input: compact single-line text field or contenteditable, often small
- Send: small icon button or Enter key — look for button near the input
- Response: appears in the popover body below the input
- Container: anchored to a toolbar/header button, may be [role="tooltip"] or [role="listbox"] or a popover div`,
};

const UI_TYPE_LABELS = {
  chat_widget    : 'Chat Widget',
  sidebar_drawer : 'Sidebar Drawer',
  inline_embedded: 'Inline Embedded',
  modal_dialog   : 'Modal Dialog',
  topbar_overlay : 'Top-bar Overlay',
};

const SCHEMA_RULES = () => SchemaValidator.describeSchema();

const SELECTOR_RULES = `
SELECTOR RULES:
- Provide 3–5 comma-separated fallback selectors, most-specific first.
- Prefer: data-testid, data-test-id, aria-label, role, placeholder attributes.
- Avoid: nth-child, generated class hashes.
- Never use :has-text() — not a valid CSS selector.
- For inputs: textarea[placeholder*='Ask'], input[placeholder*='Message'] are good fallbacks.`.trim();

// v2.74.287 — Playwright / Cypress / jQuery pseudo-class detector.
// Used to reject LLM-proposed selectors that would throw at runtime in
// document.querySelectorAll. The substrate ingests selectors authored
// by Claude (generateLandmarkProfile, suggestPerspective) and applies them
// verbatim via the standard DOM Selectors API — anything Playwright-
// specific (`:text-is(...)`, `:has-text(...)`, `text=...`, `xpath=...`,
// `:nth-match(...)`, etc.) parses as invalid CSS and the INSPECT_ELEMENT
// path surfaces a SyntaxError to the author. Detection is conservative:
// only pseudos that have NO standard CSS counterpart are flagged. Real
// CSS pseudos like `:has(...)`, `:is(...)`, `:not(...)`, `:nth-of-type`,
// `:checked`, `:disabled` are intentionally NOT in this list.
const NON_CSS_PSEUDO_REGEX = /:(?:has-text|text|text-is|text-matches|contains|light|near|nth-match|right-of|left-of|above|below)\s*\(|:visible\b|:hidden\b|^(?:text|xpath|css|id|data-testid)\s*=/i;

function _looksLikePlaywrightSelector(sel) {
  if (!sel || typeof sel !== 'string') return false;
  return NON_CSS_PSEUDO_REGEX.test(sel);
}

const TIMING_RULES = `
TIMING RULES:
- After NAVIGATE: WAIT_FOR a reliable landmark, timeout 10000.
- After any CLICK that opens a panel/modal/dropdown: WAIT_FOR the INPUT inside it, timeout 8000.
- After submitting a question (send CLICK): do NOT use WAIT_FOR. Proceed directly to EXTRACT.
  The system handles response-ready detection automatically. Using WAIT_FOR after send causes
  false positives on pre-existing chat history elements.
- WAIT (unconditional) only when nothing specific to wait for.`.trim();

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} NextStepOptions
 * @property {string}   aiName
 * @property {string}   groundUrl
 * @property {string}   dom            - Interactive DOM summary from content script.
 * @property {Object[]} confirmedSteps - Steps confirmed so far.
 * @property {number}   turn           - Current turn number (1-based).
 * @property {number}   maxTurns       - Cap for the walk.
 * @property {string|null} lastStepError - Error from previous step if it failed; null otherwise.
 */

/**
 * @typedef {Object} NextStepResult
 * @property {boolean}     success
 * @property {Object|null} step    - Single validated step object.
 * @property {string|null} error
 */

/**
 * @typedef {Object} GenerateTemplateOptions
 * @property {string} groundUrl
 * @property {string} aiName
 * @property {string} domSnapshot
 * @property {string} [screenshot]
 */

/**
 * @typedef {Object} GenerateResult
 * @property {boolean}     success
 * @property {string|null} rawJson
 * @property {Object[]|null} steps
 * @property {string|null} error
 */

// ─── AnthropicService ─────────────────────────────────────────────────────────

export class AnthropicService {

  // ── Key management ────────────────────────────────────────────────────────

  /**
   * Saves the Anthropic API key to persistent storage.
   * @param {string} key
   * @returns {Promise<void>}
   */
  static async saveApiKey(key) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: key.trim() });
    Logger.info('AnthropicService', 'API key saved');
  }

  /**
   * Retrieves the stored Anthropic API key.
   * @returns {Promise<string|null>}
   */
  static async getApiKey() {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    return data[SETTINGS_KEY] ?? null;
  }

  /**
   * C-P3 (DD-08) — resolve the LLM transport. When signed in to the cloud, route to the app's
   * managed proxy (/llm/messages) with the Cognito Bearer token so NO client key is needed.
   * Otherwise fall back to a direct Anthropic call with the locally-stored key. Throws
   * 'no-llm-transport' when neither is available. Returns { url, headers } where the caller adds
   * Content-Type and the request body.
   * @returns {Promise<{ url: string, headers: Record<string,string> }>}
   * @private
   */
  static async #llmTransport() {
    try {
      const settings = await getCloudSettings();
      if (settings?.enabled) {
        const session = await ensureFreshSession();
        if (session?.idToken) {
          return {
            url: `${normalizeApiBaseUrl(settings.apiBaseUrl)}/llm/messages`,
            headers: { 'Authorization': `Bearer ${session.idToken}` },
          };
        }
      }
    } catch { /* fall through to direct (BYO key) */ }
    const apiKey = await AnthropicService.getApiKey();
    if (!apiKey) throw new Error('no-llm-transport');
    return {
      url: ANTHROPIC_API_URL,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    };
  }

  /**
   * True if any LLM transport is usable: a managed proxy (cloud-enabled +
   * signed in) OR a local BYO key. UI guards (CHECK_API_KEY) call this instead
   * of getApiKey() so a no-key install still works once signed into the cloud.
   * @returns {Promise<boolean>}
   */
  static async hasLlm() {
    try { await AnthropicService.#llmTransport(); return true; } catch { return false; }
  }

  // ── Recursive walk API ────────────────────────────────────────────────────

  /**
   * Given the current live tab state and the confirmed step history, asks Claude
   * to return the single next step that should be executed. Used by TemplateWalker
   * on every turn of the recursive walk.
   *
   * Claude receives:
   *   - A screenshot of the current page state
   *   - The curated DOM snapshot
   *   - All steps confirmed so far (so it knows where it is in the journey)
   *   - The turn number (so it knows how many steps remain)
   *
   * Claude returns exactly ONE step object as a JSON object (not an array).
   *
   * @param {NextStepOptions} options
   * @returns {Promise<NextStepResult>}
   */
  /**
   * Phase-aware dispatcher. Routes to the correct prompt set based on phase.
   *
   * @param {Object}  options
   * @param {1|2}     options.phase          - 1 = navigation/discovery, 2 = interaction.
   * @param {string}  options.aiName
   * @param {string[]} options.aliases        - User-supplied AI name aliases.
   * @param {string}  options.groundUrl
   * @param {string}  options.dom
   * @param {Object[]} options.confirmedSteps
   * @param {number}  options.turn
   * @param {number}  options.maxTurns
   * @param {string|null} options.lastStepError
   * @param {string}  [options.sampleQuestion]   - Phase 2 only.
   * @param {Object}  [options.handoff]           - Phase 2 only: { inputSelector }.
   * @returns {Promise<NextStepResult>}
   */
  static async getNextStep(options) {
    return options.phase === 2
      ? AnthropicService.#getNextStep_phase2(options)
      : AnthropicService.#getNextStep_phase1(options);
  }

  // ── Phase 1: navigation / access point discovery ──────────────────────────

  static async #getNextStep_phase1(options) {
    const { aiName, aliases = [], groundUrl, dom, confirmedSteps, turn, maxTurns, lastStepError, uiType } = options;

    if (!(await AnthropicService.hasLlm())) return { success: false, step: null, error: 'No API key' };

    const aliasHint = aliases.length
      ? `Known aliases for this AI in the UI: ${aliases.join(', ')}.`
      : '';
    const navHint = uiType && UI_TYPE_NAV_HINTS[uiType]
      ? `\n${UI_TYPE_NAV_HINTS[uiType]}`
      : '';

    const systemPrompt = `You are a browser automation engineer navigating to an AI assistant's chat input.

Your ONLY goal in this phase: find and open the AI chat interface so the input is visible and ready.
${aliasHint}
${navHint}

Permitted actions: NAVIGATE, CLICK, FIND_AI, WAIT, WAIT_FOR.
FORBIDDEN actions: TYPE, EXTRACT — do not attempt to interact with the AI yet.

You are done when an AI chat input is visible in the DOM. At that point return:
{"step":${turn},"action":"FIND_AI","selector":"","value":""}

FIND_AI will automatically locate and click the AI entry point using the aliases above.
After FIND_AI succeeds, the panel will open. Use WAIT_FOR to confirm the input appeared.
Once the input is confirmed present, the phase is complete — return FIND_AI or the CLICK that opens it.

${SELECTOR_RULES}

TIMING RULES:
- After NAVIGATE: WAIT_FOR a reliable landmark, timeout 10000.
- After CLICK that opens a panel: WAIT_FOR the input inside it, timeout 10000.
- Use WAIT only when nothing specific to wait for.

CRITICAL — OUTPUT FORMAT:
Return ONLY a single raw JSON object. No prose before or after.
{"step":${turn},"action":"CLICK","selector":"[aria-label='Open Assistant']","value":""}`;

    const recentSteps = confirmedSteps.slice(-5);
    const historyText = recentSteps.length > 0
      ? `Last ${recentSteps.length} confirmed step(s) of ${confirmedSteps.length} total:\n${JSON.stringify(recentSteps, null, 2)}`
      : 'No confirmed steps yet.';

    const errorContext = lastStepError
      ? `\nLast step FAILED: "${lastStepError}"\n`
      : '';

    const userContent = [{
      type: 'text',
      text: `AI: ${aiName}\nURL: ${groundUrl}\nTurn: ${turn}/${maxTurns}\n\n${historyText}${errorContext}\n\nDOM:\n${dom}\n\nNext step:`,
    }];

    Logger.info('AnthropicService', `getNextStep P1 turn ${turn} — confirmed: ${confirmedSteps.length}${lastStepError ? ' [err]' : ''}`);

    const raw = await AnthropicService.#call(systemPrompt, userContent, 256, [
      { role: 'assistant', content: '{"step":' },
    ]);
    if (!raw.success) return { success: false, step: null, error: raw.error };

    return AnthropicService.#parseAndValidateStep('{"step":' + raw.text, turn);
  }

  // ── Phase 2: interaction discovery ───────────────────────────────────────

  static async #getNextStep_phase2(options) {
    const { aiName, aliases = [], groundUrl, dom, confirmedSteps, turn, maxTurns, lastStepError, sampleQuestion, handoff, uiType } = options;

    if (!(await AnthropicService.hasLlm())) return { success: false, step: null, error: 'No API key' };

    const SAMPLE_Q    = sampleQuestion || 'How can you help me?';
    const aliasHint   = aliases.length
      ? `This AI is known as: ${aiName}. UI aliases: ${aliases.join(', ')}.`
      : `This AI is known as: ${aiName}.`;
    const inputHint   = handoff?.inputSelector
      ? `Phase 1 identified the chat input as: ${handoff.inputSelector} — verify against the DOM before using.`
      : 'Identify the chat input from the DOM below.';
    const shapeHint   = uiType && UI_TYPE_SHAPES[uiType]
      ? `\n${UI_TYPE_SHAPES[uiType]}`
      : '';

    const systemPrompt = `You are a browser automation engineer. The AI assistant panel is open.

${aliasHint}
${inputHint}
${shapeHint}

YOUR TASK: Discover and execute the complete interaction path inside this panel:
  1. TYPE the question into the chat input
  2. CLICK the send/submit button
  3. EXTRACT the AI response

Read the DOM carefully. The panel DOM is your ground truth. Use what you see.

Permitted actions: TYPE, CLICK, WAIT, EXTRACT.
FORBIDDEN: NAVIGATE, FIND_AI, WAIT_FOR.

## DOM attributes — read these carefully every turn
  text="..."        — the element's actual visible text content
  disabled="true"   — element is currently disabled or aria-disabled
  new="true"        — element appeared THIS turn (was not present last turn)
  changed="true"    — element was present last turn but its text or state changed

## How to determine when generation is complete
Look for these signals that the AI has finished responding:
  - A status/loading element whose text="..." changes to a duration (e.g. "Reasoned for 2s") — generation done
  - A send button with disabled="true" during generation — when it loses disabled, generation done
  - An element with new="true" and substantial text — that IS the response, extract immediately
  - An element with aria-busy="true" or changed="true" on a loading indicator — still generating

## How to write the EXTRACT selector
After generation completes you will see a new element with new="true" and text="..." containing the AI response.
  1. Find the element with new="true" and the most substantial text — that is the response
  2. Use its data-testid as the selector
  3. Do NOT select short-text elements (buttons, labels, status messages)
  4. Do NOT select elements whose text matches the user's typed question

## Action rules
| action  | selector                                  | value                    |
|---------|-------------------------------------------|--------------------------|
| TYPE    | chat input from DOM                       | ${SAMPLE_Q} (ABSOLUTE)  |
| CLICK   | send button from DOM                      | "" (empty)               |
| WAIT    | "" (empty)                                | milliseconds e.g. "1500" |
| EXTRACT | element with new="true" and response text | "" (empty)               |

WAIT: value must be a plain number. Only use before TYPE if panel needs to settle.
After send CLICK: go directly to EXTRACT — response timing is handled automatically.
If EXTRACT fails: try a more specific selector or parent/child of the element you tried.

CRITICAL — OUTPUT FORMAT: Return ONLY a single raw JSON object.
{"step":${turn},"action":"TYPE","selector":"[data-test-id='prose-mirror-chat-input']","value":"${SAMPLE_Q}"}
{"step":${turn},"action":"CLICK","selector":"button[data-test-id='chat-send-button']","value":""}
{"step":${turn},"action":"EXTRACT","selector":"[data-test-id='chat-message']","value":""}
{"step":${turn},"action":"WAIT","selector":"","value":"1500"}`;

    const recentSteps = confirmedSteps.slice(-5);
    const historyText = recentSteps.length > 0
      ? `Last ${recentSteps.length} confirmed step(s) of ${confirmedSteps.length} total:\n${JSON.stringify(recentSteps, null, 2)}`
      : 'No confirmed steps yet.';

    const errorContext = lastStepError
      ? `\nLast step FAILED: "${lastStepError}"\n`
      : '';

    const userContent = [{
      type: 'text',
      text: `AI: ${aiName}\nURL: ${groundUrl}\nTurn: ${turn}/${maxTurns}\n\n${historyText}${errorContext}\n\nDOM:\n${dom}\n\nNext step:`,
    }];

    Logger.info('AnthropicService', `getNextStep P2 turn ${turn} — confirmed: ${confirmedSteps.length}${lastStepError ? ' [err]' : ''} [DOM only]`);

    const raw = await AnthropicService.#call(systemPrompt, userContent, 256, [
      { role: 'assistant', content: '{"step":' },
    ]);
    if (!raw.success) return { success: false, step: null, error: raw.error };

    return AnthropicService.#parseAndValidateStep('{"step":' + raw.text, turn);
  }

  /**
   * Shared step JSON parser + schema validator.
   * @private
   */
  static #parseAndValidateStep(rawWithPrefill, turn) {
    const cleaned = AnthropicService.#stripFences(rawWithPrefill);
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      Logger.error('AnthropicService', `Step parse error — prose returned instead of JSON`, { raw: cleaned.slice(0, 300) });
      return { success: false, step: null, error: `Claude returned prose: "${cleaned.slice(0, 100)}"` };
    }
    const validation = SchemaValidator.validate(JSON.stringify([{ ...parsed, step: 1 }]));
    if (!validation.valid) {
      Logger.warn('AnthropicService', `Step schema invalid: ${validation.error}`);
      return { success: false, step: null, error: `Step failed schema: ${validation.error}` };
    }
    return { success: true, step: parsed, error: null };
  }

  // ── Sample question generation ────────────────────────────────────────────

  /**
   * Generates a single natural, contextually appropriate sample question for
   * use during walk discovery. The question is tailored to the specific AI
   * product (aiName) and page URL so the AI responds naturally and the walk
   * produces a realistic extraction.
   *
   * Called once at walk start — before the first turn. The generated question
   * replaces the hardcoded fallback for the entire walk session, then is
   * substituted back to {{USER_QUESTION}} when the template is saved.
   *
   * Falls back to a generic question if the API call fails so the walk
   * always proceeds.
   *
   * @param {Object} options
   * @param {string} options.aiName    - Human-readable AI product name.
   * @param {string} options.groundUrl - URL of the page being tested.
   * @returns {Promise<string>} A single question string, never empty.
   */
  /**
   * Pass 5-redo — Propose the next human-readable step for an Auto-mode walk.
   *
   * The outer loop of Auto mode: given the goal, current DOM state, optional
   * screenshot, confirmed step history, and any rejection reason, returns the
   * next step the user should confirm. The step is a user-visible action
   * ("Search for jobs matching X"), NOT a DOM action. Once confirmed, the
   * inner loop (existing task walker) translates it into CLICK/TYPE sequences.
   *
   * Returns a discriminated union:
   *   { kind: 'propose', text, rationale, params }
   *   { kind: 'done' }           — goal achieved; terminate walk
   *   { kind: 'clarify', question } — reserved for future use (not yet surfaced in UI)
   *   { kind: 'error', error }
   *
   * The `params` array lists {{PARAM_NAME}} tokens that appear in the step text,
   * so the walker can pre-register them for post-walk Intent synthesis.
   *
   * @param {Object} options
   * @param {string} options.goal
   * @param {string} options.groundUrl
   * @param {string} options.dom
   * @param {string|null} options.screenshotDataUrl - data:image/jpeg;base64,...
   * @param {Array<{text:string, rationale:string, _branch?:string}>} options.confirmedOuterSteps
   * @param {Array<{text:string, reason:string}>} options.rejectedProposals
   * @param {string|null} options.activeBranchLabel
   * @param {Array<{type, label, description?}>} options.discoveryHints - form fields, page types
   */
  static async proposeNextStep({
    goal,
    groundUrl,
    dom,
    screenshotDataUrl   = null,
    confirmedOuterSteps = [],
    rejectedProposals   = [],
    activeBranchLabel   = null,
    discoveryHints      = [],
  }) {
    if (!goal?.trim()) {
      return { kind: 'error', error: 'Goal is required' };
    }

    const historyWindow = confirmedOuterSteps.slice(-5);
    const historyText = historyWindow.length === 0
      ? '(no steps confirmed yet — this is the first step)'
      : historyWindow.map((s, i) => {
          const n = confirmedOuterSteps.length - historyWindow.length + i + 1;
          const branch = s._branch ? ` [branch: ${s._branch}]` : '';
          return `${n}. ${s.text}${branch}`;
        }).join('\n');

    const rejectionsText = rejectedProposals.length === 0
      ? ''
      : `\n\nREJECTED PROPOSALS (do not repeat):\n${rejectedProposals.slice(-3).map(r =>
          `- "${r.text}" — reason: ${r.reason}`).join('\n')}\n`;

    const branchText = activeBranchLabel
      ? `\n\nACTIVE BRANCH: "${activeBranchLabel}" — current and subsequent steps belong to this branch.`
      : '';

    const hintsText = discoveryHints.length === 0
      ? ''
      : `\n\nDISCOVERY HINTS (pages/fields observed in this Ground):\n${discoveryHints.slice(0, 10)
          .map(h => `- ${h.label ?? h.type}${h.description ? `: ${h.description}` : ''}`).join('\n')}`;

    const systemPrompt = `You are assisting a user to automate a goal on a web page. Your job: propose the NEXT human-readable step toward the goal, given the current page state.

CURRENT GOAL: ${goal}

GRANULARITY — a step is a user-visible action that takes roughly 5–30 seconds for a person to do. Examples:
  GOOD: "Open the job search form and enter '{{JOB_TITLE}}' as the search term"
  TOO SMALL: "Click the search button"   — this is a DOM action, not a step
  TOO LARGE: "Complete the job application"   — this is the whole goal
  GOOD: "Fill in the shipping address with {{ADDRESS}}"
  GOOD: "Open the filters panel"
  GOOD: "Select the first matching result"

CONTEXT:
  Site URL: ${groundUrl ?? '(unknown)'}
  Recent confirmed steps:
${historyText}${branchText}${rejectionsText}${hintsText}

Use {{PARAM_NAME}} tokens in the step text when the step operates on a variable value. Example: "Search for '{{JOB_TITLE}}' in '{{LOCATION}}'". Invent descriptive UPPER_SNAKE_CASE names.

Also provide a one-sentence rationale explaining WHY this is the right next step given the page state.

RESPOND WITH JSON ONLY — no code fences, no prose:
  To propose a step:
    { "kind": "propose", "text": "...", "rationale": "...", "params": ["PARAM1","PARAM2"] }
  If the goal appears to be fully accomplished given the page state and confirmed steps:
    { "kind": "done", "rationale": "..." }
  If the goal is ambiguous and you need clarification from the user:
    { "kind": "clarify", "question": "..." }`;

    const userContent = [];
    if (screenshotDataUrl) {
      // Strip prefix and infer media type
      const match = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(screenshotDataUrl);
      if (match) {
        userContent.push({
          type: 'image',
          source: { type: 'base64', media_type: match[1], data: match[2] },
        });
      }
    }
    userContent.push({
      type: 'text',
      text: `Current DOM snapshot:\n${String(dom ?? '').slice(0, 12000)}\n\nPropose the next step toward the goal, or output {"kind":"done"} if it's complete.`,
    });

    Logger.info('AnthropicService', `proposeNextStep — goal: "${goal.slice(0, 60)}" history: ${confirmedOuterSteps.length} rejected: ${rejectedProposals.length}`);

    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 800);
      if (!raw?.success) {
        return { kind: 'error', error: raw?.error ?? 'LLM call failed' };
      }
      let text = String(raw.text ?? '').trim();
      const firstBrace = text.indexOf('{');
      const lastBrace  = text.lastIndexOf('}');
      if (firstBrace < 0 || lastBrace < firstBrace) {
        return { kind: 'error', error: 'No JSON object in response' };
      }
      text = text.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(text);

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { kind: 'error', error: 'Malformed JSON shape' };
      }

      switch (parsed.kind) {
        case 'propose': {
          if (!parsed.text) return { kind: 'error', error: 'Proposal missing text' };
          return {
            kind     : 'propose',
            text     : String(parsed.text),
            rationale: String(parsed.rationale ?? ''),
            params   : Array.isArray(parsed.params) ? parsed.params.map(String) : [],
          };
        }
        case 'done':
          return { kind: 'done', rationale: String(parsed.rationale ?? '') };
        case 'clarify':
          return { kind: 'clarify', question: String(parsed.question ?? '') };
        default:
          return { kind: 'error', error: `Unknown kind: ${parsed.kind}` };
      }
    } catch (e) {
      Logger.warn('AnthropicService', `proposeNextStep error: ${e.message}`);
      return { kind: 'error', error: e.message };
    }
  }

  /**
   * Generates the next step for a task walk (single-phase, user-defined task).
   * Claude sees the task description and live rich DOM, returns one step at a time.
   * Uses {{PARAM_NAME}} placeholders for variable values.
   */
  static async getNextTaskStep({
    taskDesc, taskSteps = [], groundUrl, dom,
    currentStepIdx = 0, currentStep = null, completedSteps = [],
    confirmedSteps, turn, maxTurns, lastStepError, isLastStep = false,
    turnsRemaining = null,
  }) {
    // Current step text and optional declared param
    const stepText  = currentStep?.text  ?? taskDesc ?? 'Complete the task';
    const stepParam = currentStep?.param ?? null;
    const stepNum   = currentStepIdx + 1;
    const totalSteps = taskSteps.length || 1;

    // Completed steps summary — brief, not the full confirmed DOM action list
    const completedSummary = completedSteps.length > 0
      ? `Completed:\n${completedSteps.join('\n')}\n`
      : '';

    // Param instruction for current step
    const paramHint = stepParam
      ? `This step has a variable value — use {{${stepParam.toUpperCase()}}} as the placeholder.`
      : 'If this step requires a variable value, invent a descriptive {{UPPER_SNAKE_CASE}} placeholder.';

    const systemPrompt = `You are a browser automation engineer completing a task on a web page one step at a time.

TASK: ${taskDesc ?? stepText}

CURRENT STEP (${stepNum} of ${totalSteps}): ${stepText}
${paramHint}

${completedSummary}Generate DOM actions to complete the CURRENT STEP only.
When the current step is fully complete, output STEP_DONE to advance.
${isLastStep ? 'This is the LAST step. After completing it, output DONE.' : ''}

## Navigation and reload detection
If the context says "PAGE_NAVIGATED: The page navigated to X", the browser navigated to a new page.
If that navigation is the expected result of the current step, output STEP_DONE immediately.

If the context says "PAGE_RELOADED: The page reloaded unexpectedly", the page refreshed mid-task.
Re-orient to the current DOM snapshot and continue the task — do not restart from step 1.
If the reload returned to a login or session page, navigate back to the task URL first.

## DOM attributes (READ-ONLY — never use in selectors)
  text="..."              — visible text
  value="..."             — current value of an input/textarea (confirms field is filled)
  label-text="..."        — label text for radio/checkbox (identifies which option it is)
  checked="true"          — radio/checkbox is currently selected
  child-href="..."        — href of child anchor (reference only)
  use-selector="a[href='...']" — READY-TO-USE selector for this element — copy it exactly
  tag-hint="select"       — native <select> dropdown — use SELECT action, not CLICK
  options="A|B|C"         — pipe-separated options in a <select>
  new="true"              — appeared this turn
  changed="true"          — changed this turn
  disabled="true"         — element is disabled
  state-class="..."       — selection-state classes (selected, active, applied) — confirms post-click state
  signal-type="..."       — this element is a transient signal (toast, alert, banner, status, progress, validation-error) — its text is a DIRECT signal about your last action. Read it before proposing the next step.
  validation-text="..."   — on an aria-invalid input, the specific error message from aria-describedby — tells you exactly what to fix
  aria-pressed/checked/selected/current="true" — SELECTION STATE. A chip, toggle, or option in its "chosen" state.
  aria-expanded="true"    — dropdown/popover is currently open; the target is likely INSIDE, not another click on this

## Body-line attributes (on the <body> element line)
  url="/path?query"       — current URL (pathname + search) — filter/navigation state changes often manifest ONLY here
  page-busy="true"        — page is loading/processing — WAIT, do not click again
  focused="tag#id"        — element currently holding focus

## Interpreting transient signals (IMPORTANT)
When the previous turn was a submit/save and the NEW snapshot contains an element with signal-type="toast|alert|status|snackbar" or validation-text="...", read that text:
  - "Saved", "Success", "Thank you", "Submitted" → the action worked. Output STEP_DONE.
  - "Error", "Failed", "Invalid", specific complaints → the action did NOT work. Fix the problem the message describes. Do NOT re-submit without addressing it.
  - validation-text on an aria-invalid input → that specific field has that specific problem. Fix it before re-submitting.

## Selector rules
text, value, label-text, checked, child-href, use-selector, tag-hint, options, state-class, signal-type, validation-text, page-busy, focused, url do NOT exist in the DOM — never use as selector attributes.
When use-selector="..." is present, copy that value exactly as your selector.
For radio/checkbox: use the element's id selector e.g. #nbsInfoBannerViewTile, not label-text.
  Wrong: input[label-text='On'], li[text='Ship']
  Right: #nbsInfoBannerViewTile, a[href*='/ship']

## Selector preference order (strong to weak)
Prefer the first available robust selector. Avoid the last categories unless nothing better exists.
  1. data-testid, data-test-id, data-key         — product test hooks, most stable
  2. aria-label exact match                      — semantic, rarely changes
  3. role + text                                 — e.g. button[aria-label='Apply'] or [role='option'][aria-label='Last 24 hours']
  4. Unique class name that is NOT hashed        — e.g. .apply-button; AVOID .css-1a2b3c
  5. Visible text via use-selector hint          — when snapshot provides it
  6. Structural path                              — last resort
AVOID: runtime-generated React ids like #:r9: or #:r1a:. These are per-render, not stable. If you see a candidate id starting with a colon, prefer anything else on the element (aria-label, role+text, data-testid).

## Do not repeat no-op actions
If the tooling tells you the previous action produced no visible change (lastStepError mentions "NO VISIBLE CHANGE"), the exact same action will fail again. DO NOT repeat it. Pick a different selector, different action type, or output STEP_DONE if the page state is already what the task requires. Repeating the same selector will abort the walk.

## Field verification
After TYPE or SELECT, the next snapshot confirms success via DOM change signals — not by matching the typed value.
If the field shows changed="true", or new elements appear nearby, the action was accepted.
Do NOT re-type. Proceed to the next field or output STEP_DONE.
Some fields transform the input (autocomplete, formatting, date pickers) — the displayed value may differ from what was typed. This is normal. changed="true" is the signal.

## BLUR after TYPE
Always emit BLUR on the same selector immediately after every TYPE action.
BLUR fires blur + focusout events that tell Angular, React, and Vue form frameworks to commit the typed value to the form model.
Without BLUR, the framework may discard the value when the next action fires.
Pattern: TYPE → BLUR (same selector) → next action.

## Drawer/panel detection
Many new="true" items after a CLICK = panel opened. Click the target inside — not the trigger again.

## Autocomplete inputs
TYPE the value → BLUR (same selector) → WAIT 1500 → CLICK the first suggestion from the dropdown.
Exception: if the autocomplete parses the input into multiple fields (e.g. address → street/city/state/zip),
move the BLUR to after the suggestion CLICK so it doesn't dismiss the dropdown prematurely:
TYPE → WAIT 1500 → WAIT_FOR suggestion → CLICK suggestion → BLUR (address selector).

## Actions
| action    | selector              | value                                        |
|-----------|-----------------------|----------------------------------------------|
| CLICK     | CSS selector          | "" (empty)                                   |
| TYPE      | CSS selector          | value or {{PARAM_NAME}}                      |
| BLUR      | CSS selector          | "" — fires blur/focusout on the element      |
| SELECT    | CSS selector of the   | option value, visible text, or index (0,1,2) |
|           | <select> element      | Use for native dropdown/select elements      |
| NAVIGATE  | "" (empty)            | full URL                                     |
| WAIT      | "" (empty)            | milliseconds e.g. "1500"                     |
| SCROLL_TO | CSS selector          | "" — scrolls element into view, no DOM change|
| STEP_DONE | "" (empty)            | "" — current step complete                   |
| DONE      | "" (empty)            | "" — entire task complete                    |

Use SELECT (not CLICK) for native <select> dropdowns — it sets the value and fires change events correctly.

## Capturing data from the page
Do NOT emit EXTRACT or ENUMERATE actions. Page→data capture (reading values, lists,
or attributes from the page into named bindings) belongs to the Observation primitive,
which the user authors separately. If the user's task description includes a
capture/extract/scrape step, complete the side-effecting actions you can (clicks,
typing, navigation), then output STEP_DONE — the user will author an Observation
to capture the data. If the entire current step is a pure capture step with no
side effects, output STEP_DONE immediately and let the user author an Observation.

## When to use SCROLL_TO
SCROLL_TO is a *visibility-only* action — it scrolls a target element into view but does NOT click, type, or change page state. Use it when:
- The description says "scroll to," "reveal," "show," "jump to," "find," or "make visible."
- The description says the user will manually act on the element (e.g., "scroll to the device's bridge button so the user can click it").
- The target element is below the fold and a subsequent action (or human) needs it visible.

Do NOT use SCROLL_TO when:
- The description says to interact with the element (CLICK does its own scrolling).
- A CLICK or TYPE on the same element is the next step — they handle visibility themselves.

After SCROLL_TO, the DOM does not change. Issue STEP_DONE on the next turn — do not expect domChanged:true. The page may show a different region, but the structural snapshot is the same.

### CRITICAL: visibility-only tasks
Some tasks transform state (CLICK, TYPE, NAVIGATE). Other tasks are visibility-only — they reveal an element so a human or downstream step can act on it. Visibility-only tasks have no DOM mutation; the entire fragment is SCROLL_TO + STEP_DONE + DONE.

If the task description starts with "Scroll to," "Reveal," "Show," or "Make visible," your FIRST action MUST be SCROLL_TO targeting the named element. Do NOT WAIT first — there is nothing to wait for. Do NOT output STEP_DONE before scrolling — the fragment must contain the SCROLL_TO action so it works when reused on pages where the target is below the fold.

Always emit SCROLL_TO even if the target element appears visible in the current DOM. SCROLL_TO is idempotent (scrolling to an already-visible element is a no-op), and the fragment will be reused on pages where the element isn't yet visible.

### Worked example
Description: "Scroll to the Save button so the user can click it."

Turn 1 → SCROLL_TO: {"action":"SCROLL_TO","selector":"button[aria-label='Save']","value":""}
Turn 2 → STEP_DONE: {"action":"STEP_DONE","selector":"","value":""}
Turn 3 → DONE: {"action":"DONE","selector":"","value":""}

Three turns total. No WAITs. The SCROLL_TO produces no DOM change and that's expected — proceed to STEP_DONE on turn 2 regardless.

OUTPUT FORMAT — CRITICAL:
Return a SINGLE LINE of raw JSON. No newlines inside the object. No markdown. No explanation.
CORRECT:   {"action":"CLICK","selector":"button[aria-label='Ship']","value":""}
INCORRECT: Multi-line JSON, code fences, or any text before/after the JSON object.`;

    const recentDom = confirmedSteps.slice(-3);
    const historyText = recentDom.length > 0
      ? `Recent DOM actions:\n${JSON.stringify(recentDom, null, 2)}\n`
      : '';
    const errorContext = lastStepError
      ? `\nLast action FAILED: "${lastStepError}" — try a different approach.\n`
      : '';
    const lowTurnWarning = turnsRemaining !== null && turnsRemaining <= 5
      ? `\n⚠ ONLY ${turnsRemaining} TURNS REMAINING — skip retries, complete remaining steps and DONE immediately.\n`
      : '';

    const userContent = [{
      type: 'text',
      text: `URL: ${groundUrl}\nTurn: ${turn}/${maxTurns}\n\n${historyText}${errorContext}${lowTurnWarning}DOM:\n${dom}\n\nNext action for step ${stepNum}:`,
    }];

    Logger.info('AnthropicService', `getNextTaskStep turn ${turn} — step ${stepNum}/${totalSteps} confirmed:${confirmedSteps.length}`);

    const raw = await AnthropicService.#call(systemPrompt, userContent, 500);
    if (!raw.success) return { success: false, error: raw.error };

    try {
      const parsed = JSON.parse(AnthropicService.#extractJson(
        AnthropicService.#stripFences(raw.text ?? '')
      ));
      if (!parsed.action) throw new Error('No action field');
      return { success: true, step: { ...parsed, selector: parsed.selector ?? '', value: parsed.value ?? '' } };
    } catch (e) {
      Logger.warn('AnthropicService', `getNextTaskStep parse error: ${e.message} — raw: ${raw.text?.slice(0, 80)}`);
      return { success: false, error: `Parse error: ${e.message}` };
    }
  }

  static async generateSampleQuestion({ aiName, aliases = [], groundUrl }) {
    const FALLBACK = 'What can you help me with today?';
    const aliasHint = aliases.length ? ` (also known as: ${aliases.join(', ')})` : '';

    const systemPrompt = `You generate a single opening message that a real user would type when first starting a conversation with an AI assistant.

The message will be used during automated testing to exercise the full chat interaction path.

Requirements:
- Must be a natural, conversational first message — the kind of thing a real person types when opening a chat
- Must work for ANY AI assistant regardless of domain — no product-specific assumptions
- Short: under 10 words
- Sounds human — not robotic, not a test string
- Produces a real response (the AI will reply with something substantive)
- Varies each time — pick from the style of these examples but do not copy them:
  "What can you help me with?"
  "Give me a quick overview of what you do"
  "Where should I start?"
  "What are you good at?"
  "Help me understand what I can ask you"
  "What's the most useful thing you can do for me?"
  "Walk me through what you can do"
  "I'm new here, where do I begin?"

Return ONLY the message text. No quotes, no explanation.`;

    const userContent = [{
      type: 'text',
      text: `AI Product: ${aiName}${aliasHint}\nURL: ${groundUrl}\n\nGenerate the opening message.`,
    }];

    Logger.info('AnthropicService', `generateSampleQuestion — "${aiName}" (${groundUrl})`);

    const raw = await AnthropicService.#call(systemPrompt, userContent, 32);

    if (!raw.success || !raw.text?.trim()) {
      Logger.warn('AnthropicService', `generateSampleQuestion failed — using fallback. ${raw.error ?? ''}`);
      return FALLBACK;
    }

    const question = raw.text.trim().replace(/^["']|["']$/g, '');
    Logger.info('AnthropicService', `Sample question: "${question}"`);
    return question || FALLBACK;
  }

  // ── Profile question generation ───────────────────────────────────────────

  /**
   * Generates N capability-eliciting questions for the profiling pass.
   * Questions are designed to make the AI enumerate its domains, data sources,
   * and capabilities in professional language — building a rich semantic
   * knowledge base for runtime question matching.
   *
   * Only aiName and groundUrl are sent — no CRM data, no response content.
   * Privacy-safe: nothing from the ground's live data touches the API.
   *
   * @param {Object} options
   * @param {string} options.aiName
   * @param {string} options.groundUrl
   * @param {number} [options.count=5]
   * @returns {Promise<string[]>} Array of question strings, length ≤ count.
   */
  static async generateProfileQuestions({ aiName, groundUrl, count = 5 }) {
    const systemPrompt = `You generate introspective meta-questions for an AI assistant product.

These questions will be submitted directly to the AI during an automated profiling session.
Their purpose is to build a semantic capability map — understanding what the AI knows about
itself, what it can do, and what its boundaries are.

The questions must be INTROSPECTIVE — asking the AI about its own capabilities, not asking
it to perform a task. The responses will be used to semantically match future user questions
to the right AI assistant.

Generate exactly ${count} questions that together would reveal:
1. What categories or types of questions the AI is best equipped to answer
2. What data sources, records, or systems it has access to
3. What kinds of tasks it can perform (lookup, summarise, analyse, recommend, etc.)
4. What its professional context is and who its intended users are
5. What is explicitly outside its capabilities or scope

GOOD examples (introspective, capability-mapping):
- "What types of questions are you best equipped to answer?"
- "What data or records do you have direct access to?"
- "What business functions or departments are you primarily designed to support?"
- "What kinds of tasks are outside your current capabilities?"
- "How would you describe your primary purpose to a new user?"

BAD examples (task-specific, domain-execution — do NOT generate these):
- "How do I improve my B2B campaign?"
- "Find contacts in the healthcare industry"
- "Summarise last quarter's pipeline"

Requirements:
- Each question is standalone and self-contained
- Phrased as if speaking directly to the AI ("What can you...", "How would you...")
- Professional business English
- Maximum 15 words each
- Varied — cover different capability dimensions
- No overlap between questions

Return a JSON array of ${count} question strings. No explanation, no markdown, only the JSON array.`;

    const userContent = [{
      type: 'text',
      text: `AI Product: ${aiName}\nURL: ${groundUrl}\n\nGenerate ${count} introspective capability-mapping questions.`,
    }];

    Logger.info('AnthropicService', `generateProfileQuestions — "${aiName}" count:${count}`);

    const raw = await AnthropicService.#call(systemPrompt, userContent, 512, [
      { role: 'assistant', content: '[' },
    ]);

    if (!raw.success) {
      Logger.warn('AnthropicService', `generateProfileQuestions failed: ${raw.error}`);
      return [];
    }

    try {
      const cleaned = AnthropicService.#stripFences('[' + raw.text);
      const parsed  = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) throw new Error('Not an array');
      const questions = parsed.filter(q => typeof q === 'string' && q.trim()).slice(0, count);
      Logger.info('AnthropicService', `Generated ${questions.length} profile questions`);
      return questions;
    } catch (e) {
      Logger.warn('AnthropicService', `generateProfileQuestions parse error: ${e.message}`);
      return [];
    }
  }

  // ── Runtime question matching ─────────────────────────────────────────────

  /**
   * Generates a semantic routing profile for a task ground.
   * Unlike AI grounds which build profiles from live Q&A exchanges, task ground
   * profiles are generated directly from the task description, steps, and params.
   *
   * @param {Object} options
   * @param {string}   options.taskName  - Display name of the task ground.
   * @param {string}   options.taskDesc  - Summary description of the task.
   * @param {Object[]} options.taskSteps - Array of { text, param } step objects.
   * @param {string[]} options.params    - Discovered parameter names.
   * @param {string}   options.groundUrl - URL of the target site.
   * @returns {Promise<Object|null>} Profile object or null on failure.
   */
  static async generateTaskProfile({ taskName, taskDesc, taskSteps = [], params = [], groundUrl }) {
    const stepsText = taskSteps.map((s, i) => `${i + 1}. ${s.text}${s.param ? ` [{{${s.param}}}]` : ''}`).join('\n');
    const paramsText = params.length
      ? params.map(p => `  ${p}: (value required at runtime)`).join('\n')
      : '  None';

    const systemPrompt = `You generate a semantic routing profile for an automated browser task.

The profile is used to match natural language user requests to this task at runtime.
It must accurately describe what the task does so the router can decide whether a user's
request should trigger this task.

Return a JSON object with exactly these fields:

"summary" — One sentence describing what this task does and what it produces.
  Be specific. Include the site name if relevant. Example:
  "Creates a UPS shipping label by navigating the UPS website, entering sender and recipient details, and reviewing the shipment."

"domains" — Array of 3–6 short strings describing the task's domain.
  Example: ["shipping", "logistics", "package delivery", "UPS", "label creation"]

"triggers" — Array of 5–8 natural language phrases a user might say to invoke this task.
  Include variations in phrasing. Example:
  ["ship a package", "create a shipping label", "send something via UPS", "I need to ship this"]

"params" — Object mapping each parameter name to a one-sentence description of what value it expects.
  Example: {"SENDER_NAME": "Full name or company name of the sender", "PACKAGE_WEIGHT": "Weight of the package in pounds"}

"capabilities" — Array of 3–5 strings describing specific things this task can do.
  Example: ["Create UPS domestic shipping labels", "Enter sender and recipient addresses", "Specify package weight"]

"limitations" — Array of 2–3 strings describing what this task cannot do.
  Example: ["Cannot process international shipments", "Requires a valid UPS account"]

Return ONLY the JSON object. No explanation, no markdown.`;

    const userContent = [{
      type: 'text',
      text: `Task name: ${taskName}\nTask description: ${taskDesc}\nSite: ${groundUrl}\n\nTask steps:\n${stepsText}\n\nParameters:\n${paramsText}\n\nGenerate the routing profile.`,
    }];

    Logger.info('AnthropicService', `generateTaskProfile — "${taskName}"`);

    const raw = await AnthropicService.#call(systemPrompt, userContent, 800);
    if (!raw.success) {
      Logger.warn('AnthropicService', `generateTaskProfile failed: ${raw.error}`);
      return null;
    }

    try {
      const parsed = JSON.parse(AnthropicService.#extractJson(AnthropicService.#stripFences(raw.text ?? '')));
      if (!parsed.summary) throw new Error('No summary field');
      Logger.info('AnthropicService', `generateTaskProfile complete — "${parsed.summary.slice(0, 80)}"`);
      return { ...parsed, groundType: 'task', generatedAt: Date.now() };
    } catch (e) {
      Logger.warn('AnthropicService', `generateTaskProfile parse error: ${e.message}`);
      return null;
    }
  }

  /**
   * capability profiles. Returns grounds ranked by confidence (0–1).
   *
   * Each profile contains structured capability data built during the profiling
   * pass. Claude compares the question's intent against each profile's domains,
   * capabilities, and sample exchanges to produce a confidence score.
   *
   * @param {Object}   options
   * @param {string}   options.question       - The user's runtime question.
   * @param {Object[]} options.groundProfiles - Array of { groundId, aiName, profile } objects.
   * @returns {Promise<Array<{ groundId: string, aiName: string, confidence: number, reason: string }>>}
   *   Sorted descending by confidence.
   */
  /**
   * Classify a single page during Discovery. Takes a page URL and its DOM
   * snapshot, returns a structured classification: page type, title, visible
   * form fields (with labels and input types), and outgoing navigation links
   * worth crawling further.
   *
   * Used by DiscoveryService. Read-only analysis — the classifier never
   * triggers actions on the page. Cost-optimized: one Claude call per page,
   * Sonnet for accuracy on the classification decision.
   *
   * @param {Object} options
   * @param {string} options.url
   * @param {string} options.title       - document.title
   * @param {string} options.domSnapshot - compact DOM snapshot produced by DOM_SNAPSHOT_RICH
   * @returns {Promise<{
   *   pageType: 'list'|'detail'|'form'|'confirmation'|'other',
   *   title: string,
   *   formFields: Array<{label:string, selector:string, type:string, required:boolean}>,
   *   outgoingLinks: Array<{text:string, href:string}>
   * }|null>}
   */
  /**
   * v2.74.41 — Site-level summary used by the Ground sidepanel's Discover
   * flow. Given a domain and a sample of crawled pages, returns:
   *   name        — short brand/site name (1-3 words)
   *   aliases     — 2-6 alternate terms a user might call this site
   *   description — 1-2 sentence "what this site is for" blurb
   *
   * Pages are an array of { url, title, pageType } records — the same
   * shape DiscoveryService.classifyPage produces.
   *
   * @param {Object} options
   * @param {string} options.domain
   * @param {Array<Object>} options.pages
   * @returns {Promise<{ name: string, aliases: string[], description: string } | null>}
   */
  static async summarizeSite({ domain, pages }) {
    if (!domain || !Array.isArray(pages) || pages.length === 0) return null;
    const samples = pages.slice(0, 10).map(p => ({
      url      : p.url,
      title    : p.title,
      pageType : p.pageType,
    }));
    const systemPrompt = `You summarize a website for a structured automation library. Given a domain and a sample of pages crawled from it, return a JSON summary.

Return ONLY a JSON object with exactly these fields:
{
  "name": "...",                 // Short, recognizable site name (1-3 words). Use the brand, not the domain. Examples: "Pixabay", "Stack Overflow", "Reddit".
  "aliases": ["...", "..."],     // 2-6 alternate terms a user might call this site when asking the assistant. Examples: ["image library", "stock photos", "free images"] for Pixabay. Descriptive, not the same as the name.
  "description": "..."           // 1-2 sentences in active voice describing what a user can do on this site. Examples: "Search and download royalty-free images, videos, and music for your projects." or "Ask and answer technical programming questions; vote on answers from other developers."
}

Rules:
- Be concrete. Avoid filler phrases like "is a website" or "is a platform".
- aliases should reflect how a user thinks about the site, not its branding (e.g. "stack overflow" is the name; "programming Q&A" is an alias).
- Skip empty / placeholder values — never return "Unknown" or empty strings.`;

    const userContent = [{
      type: 'text',
      text:
        `Domain: ${domain}\n\n` +
        `Sample pages (${samples.length} of ${pages.length} crawled):\n` +
        samples.map(p => `- ${p.pageType ?? '?'}: ${p.title ?? '(no title)'} — ${p.url}`).join('\n'),
    }];

    Logger.info('AnthropicService', `summarizeSite — ${domain} (${samples.length} pages)`);

    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 600);
      if (!raw?.success) {
        Logger.warn('AnthropicService', `summarizeSite failed: ${raw?.error}`);
        return null;
      }
      let text = String(raw.text ?? '').trim();
      const firstBrace = text.indexOf('{');
      const lastBrace  = text.lastIndexOf('}');
      if (firstBrace < 0 || lastBrace < firstBrace) {
        Logger.warn('AnthropicService', `summarizeSite returned no JSON: ${text.slice(0, 200)}`);
        return null;
      }
      text = text.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(text);
      return {
        name        : typeof parsed.name === 'string' ? parsed.name.trim() : '',
        aliases     : Array.isArray(parsed.aliases) ? parsed.aliases.map(s => String(s).trim()).filter(Boolean) : [],
        description : typeof parsed.description === 'string' ? parsed.description.trim() : '',
      };
    } catch (e) {
      Logger.warn('AnthropicService', `summarizeSite error: ${e.message}`);
      return null;
    }
  }

  // v2.74.392 — suggestPerspective REMOVED with the legacy auto-suggested-landmarks
  // feature. Perspectives are authored via the description-first propose→resolve→
  // auto-structure flow (proposePerspectives / resolveRoles / proposePerspectiveStructure).

  /**
   * v2.74.329 — GROUND_SPEC § 5 derived intent. Synthesize a short
   * natural-language summary of "what this Ground is for" from its
   * constituent Perspectives' names + descriptions. Returns plain text (no JSON)
   * or null on failure. Prompt snapshot registered in getPromptTexts under
   * 'deriveGroundDescription'.
   * @param {{ name?: string, urlPrimary?: string, perspectives: Array<{name?:string, description?:string}> }} params
   * @returns {Promise<string|null>}
   */
  static async deriveGroundDescription({ name, urlPrimary, perspectives }) {
    const list = Array.isArray(perspectives) ? perspectives.filter(l => l && (l.name || l.description)) : [];
    if (list.length === 0) return null;

    const systemPrompt = `You are writing a short, factual summary of a "Ground" — a user's automation surface for a single website. The Ground is COMPOSED of Perspectives (each Perspective is a "kind of page" on the site, with a name and description). Synthesize what the WHOLE site-level automation surface is for, from its constituent Perspectives.

Return ONLY the summary text — no preamble, no JSON, no markdown headers, no surrounding quotes.

Rules:
- 1-3 sentences. Concise. Plain prose.
- Describe what the site is and what automation across these Perspectives accomplishes — the emergent whole, not a list of the Perspectives.
- Active voice, user's perspective. Do not invent capabilities not implied by the Perspectives.
- Do not restate the URL or repeat the Ground name verbatim as a label.`;

    const perspectiveBlock = list.map((l, i) =>
      `${i + 1}. ${l.name ?? '(unnamed)'}: ${(l.description ?? '').trim() || '(no description)'}`
    ).join('\n');

    const userContent = [{
      type: 'text',
      text: `Ground name: ${name ?? '(unnamed)'}\nPrimary URL: ${urlPrimary ?? '(unknown)'}\n\nConstituent Perspectives:\n${perspectiveBlock}`,
    }];

    Logger.info('AnthropicService', `deriveGroundDescription — "${name ?? '?'}" from ${list.length} perspective(s)`);

    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 400, [], { role: 'describe', operation: 'deriveGroundDescription' });
      if (!raw?.success) {
        Logger.warn('AnthropicService', `deriveGroundDescription failed: ${raw?.error}`);
        return null;
      }
      const text = String(raw.text ?? '').trim();
      return text || null;
    } catch (e) {
      Logger.warn('AnthropicService', `deriveGroundDescription error: ${e.message}`);
      return null;
    }
  }

  /**
   * v2.74.336 — PERSPECTIVE_SPEC § 3 Layer 2 / § 13 LLM-as-author. Organize a
   * set of already-captured landmarks into a structured perspective:
   * a LandmarkNode[] tree (contains/role/multiplicity) + optional
   * groupings/sequences overlays. The LLM proposes structure; the user
   * reviews. Returns null on failure. Prompt snapshot registered in
   * getPromptTexts under 'proposePerspectiveStructure'.
   *
   * v2.74.347 — PERSPECTIVE_SPEC § 5 review-as-input. When the caller passes
   * `priorStructure` (the structure the user already reviewed, with per-node
   * `authoringMetadata.userJudgment`), this becomes a REFINE call: the prior
   * accepted/edited arrangements are preserved and the rejected ones are
   * re-thought, instead of proposing from a blank slate. This is what makes
   * the structured tree + the user's judgments an actual downstream consumer.
   *
   * @param {{ name?: string, description?: string, landmarks: Array<{uid:string, alias?:string, description?:string}>, priorStructure?: { nodes?: Array, groupings?: Array, sequences?: Array } }} params
   * @returns {Promise<{ nodes: Array, groupings: Array, sequences: Array }|null>}
   */
  static async proposePerspectiveStructure({ name, description, landmarks, priorStructure }) {
    const list = Array.isArray(landmarks)
      ? landmarks.filter(l => l && typeof l.uid === 'string' && l.uid)
      : [];
    if (list.length === 0) return null;
    const allowed = new Set(list.map(l => l.uid));
    const aliasOf = new Map(list.map(l => [l.uid, l.alias ?? '(none)']));

    // v2.74.347 — Serialize the prior reviewed structure (refs clamped to the
    // current landmark set; judgments surfaced) so the model refines instead
    // of starting over. Returns '' when there's nothing reviewed to refine.
    const priorBlock = AnthropicService.#serializePriorStructure(priorStructure, allowed, aliasOf);
    const refining = priorBlock !== '';

    const systemPrompt = `You organize a set of already-captured page landmarks into a structured "perspective" (a Perspective) for a web-automation library. You are given the perspective's name + intent and a flat list of landmarks (each: a stable "ref" id, an alias, a description). Infer the STRUCTURE — which landmarks contain others, their semantic roles, and how many occur at runtime.

Return ONLY a JSON object:
{
  "nodes": [
    { "ref": "<control-id>", "role": "filter-control", "multiplicity": "one", "triggers": ["<section-a-id>", "<section-b-id>"],
      "contains": [
        { "virtual": true, "role": "dropdown-menu", "multiplicity": "conditional", "presenceCondition": "after the control is opened",
          "contains": [
            { "ref": "<section-a-id>", "role": "menu-section", "multiplicity": "one" },
            { "ref": "<section-b-id>", "role": "social-links", "multiplicity": "one" }
          ] }
      ] }
  ],
  "groupings": [ { "name": "buying-flow", "members": ["<id>", "<id>"] } ],
  "sequences": [ { "name": "checkout-steps", "steps": ["<id>", "<id>"] } ]
}

Rules:
- Use ONLY the provided ref ids. Never invent ids.
- EVERY provided landmark must appear EXACTLY ONCE in the "nodes" tree — as a root or nested inside some node's "contains".
- "contains" = DOM-like containment: use it when one landmark logically holds others (a section holds its items; a list holds its rows; a dropdown holds its menu/options). Keep nesting shallow and meaningful.
- "role" = short lowercase semantic role within the parent (e.g. product-name, primary-action, results-list, result, price-current, review). 1-3 words, kebab-case.
- "multiplicity" = one | many | optional | conditional. Use "many" for repeating items (list rows, reviews); "conditional" for a landmark only present in some state (a menu that appears after a click); default "one".
- "triggers" (optional) = ref ids whose presence/content this landmark's INTERACTION reveals or changes (a dropdown control triggers its menu; a quantity input triggers a total). The referenced ids MUST also appear as their own nodes — triggers is a cross-link, not a way to introduce new landmarks. Omit when nothing is triggered.
- "presenceCondition" (optional) = a SHORT phrase for WHEN a not-always-present landmark exists (pair with multiplicity conditional/optional) — e.g. "after the control is opened", "when in stock". Omit for always-present landmarks.
- "virtual" (optional) = set true on a CONTAINER node that holds landmarks but was NOT itself captured (a modal / menu / section wrapper). A virtual node has NO ref, MUST have a "role" and a non-empty "contains", and MAY carry multiplicity/presenceCondition. Use it when several captured landmarks are sections of one container revealed together — put the shared presenceCondition ONCE on the virtual container instead of duplicating it on each section, and DON'T mislabel one section as the whole container. Only introduce a virtual node when no captured landmark already represents that container.
- "groupings" (optional) = named clusters that cut across containment (e.g. all controls in a buying flow). "members" are ref ids.
- "sequences" (optional) = ordered user-flow steps. "steps" are ref ids in order.
- KNOWN PRIORS (authoritative — these were ESTABLISHED by automated resolution, not guesses): a landmark may list a GIVEN "role"/"multiplicity" and/or a "revealedBy" ref. Use the given role + multiplicity VERBATIM (don't relabel them). When a landmark has "revealedBy: X": add this landmark's ref to X's node "triggers"; mark this landmark conditional with a presenceCondition like "after <X> is activated"; and GROUP every landmark sharing the same revealedBy under ONE virtual container (the revealed modal/menu) nested inside X's "contains" — don't scatter co-revealed landmarks. This makes the structure match the verified interaction depth.
- Don't force structure that isn't there — a flat list of root nodes is a fine answer when landmarks are unrelated.${refining ? `

REFINING AN EXISTING STRUCTURE (a human has already reviewed your previous proposal — do NOT start over):
- Each prior node/overlay carries a [judgment]:
  - [accepted] — the user confirmed this. KEEP its role, containment, and placement unchanged.
  - [edited] — the user adjusted this themselves. Treat the user's role/containment as authoritative; KEEP it.
  - [rejected-but-kept] — the user flagged this arrangement as WRONG. Do NOT re-propose it; find a DIFFERENT structure for those landmarks.
  - (no marker) — unreviewed; you may keep or improve it.
- Preserve every accepted/edited arrangement verbatim in your output.
- Re-think only the rejected arrangements plus any landmark NOT present in the prior structure (newly added since the last proposal).
- The output shape is unchanged — still the full nodes/groupings/sequences JSON over ALL current landmarks.` : ''}`;

    const lmBlock = list.map(l => {
      let s = `- ref: ${l.uid}\n  alias: ${l.alias ?? '(none)'}\n  desc: ${(l.description ?? '').trim() || '(none)'}`;
      if (l.role)          s += `\n  role: ${l.role} (GIVEN — use verbatim)`;
      if (l.multiplicity)  s += `\n  multiplicity: ${l.multiplicity} (GIVEN)`;
      if (l.hidden)        s += `\n  hidden: only present after its trigger is activated`;
      if (l.revealedByRef && allowed.has(l.revealedByRef)) s += `\n  revealedBy: ${l.revealedByRef} (activating that landmark reveals this one)`;
      return s;
    }).join('\n');
    const userContent = [{
      type: 'text',
      text: `Perspective name: ${name ?? '(unnamed)'}\nIntent: ${(description ?? '').trim() || '(none)'}\n\nLandmarks:\n${lmBlock}${refining ? `\n\nPRIOR REVIEWED STRUCTURE (refine this):\n${priorBlock}` : ''}`,
    }];

    Logger.info('AnthropicService', `proposePerspectiveStructure — "${name ?? '?'}" over ${list.length} landmark(s)${refining ? ' [refine]' : ''}`);

    let parsed;
    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 1500, [], { role: 'propose', operation: priorStructure ? 'proposePerspectiveStructure:refine' : 'proposePerspectiveStructure' });
      if (!raw?.success) {
        Logger.warn('AnthropicService', `proposePerspectiveStructure failed: ${raw?.error}`);
        return null;
      }
      const json = AnthropicService.#firstJsonObject(raw.text);
      if (!json) { Logger.warn('AnthropicService', 'proposePerspectiveStructure: no JSON'); return null; }
      parsed = JSON.parse(json);
    } catch (e) {
      Logger.warn('AnthropicService', `proposePerspectiveStructure error: ${e.message}`);
      return null;
    }

    // ── Safety sanitizer ──────────────────────────────────────────────
    // Clamp refs to the allowed set, dedupe (first occurrence wins), clamp
    // role/multiplicity, then append any provided landmark the LLM dropped
    // as a flat root — so the stored composition NEVER loses a landmark.
    const MULT = new Set(['one', 'many', 'optional', 'conditional']);
    const seen = new Set();
    let vCount = 0;
    const sanitizeNodes = (arr) => {
      const out = [];
      for (const n of Array.isArray(arr) ? arr : []) {
        const ref = (n && typeof n.ref === 'string') ? n.ref : null;
        if (!ref || !allowed.has(ref) || seen.has(ref)) {
          // v2.74.365 — VIRTUAL container: a ref-less node with role + contains
          // is a structural wrapper (modal/menu) that wasn't captured. Keep it
          // (with a synthetic vid) instead of flattening its children up, so the
          // shared presence/condition lives once on the container.
          if (n && n.virtual === true && typeof n.role === 'string' && n.role.trim() && Array.isArray(n.contains)) {
            const kids = sanitizeNodes(n.contains);
            if (kids.length) {
              const vnode = { virtual: true, vid: `v${++vCount}`, role: n.role.trim().slice(0, 40), contains: kids };
              if (typeof n.multiplicity === 'string' && MULT.has(n.multiplicity)) vnode.multiplicity = n.multiplicity;
              if (typeof n.presenceCondition === 'string' && n.presenceCondition.trim()) vnode.presenceCondition = n.presenceCondition.trim().slice(0, 120);
              if (Array.isArray(n.triggers)) {
                const trg = [...new Set(n.triggers.filter(t => typeof t === 'string' && allowed.has(t)))].slice(0, 6);
                if (trg.length) vnode.triggers = trg;
              }
              out.push(vnode);
            }
            continue;
          }
          // unknown / duplicate ref — skip the node but still recurse its
          // children (they may be valid).
          if (n && Array.isArray(n.contains)) out.push(...sanitizeNodes(n.contains));
          continue;
        }
        seen.add(ref);
        const node = { ref };
        if (typeof n.role === 'string' && n.role.trim()) node.role = n.role.trim().slice(0, 40);
        if (typeof n.multiplicity === 'string' && MULT.has(n.multiplicity)) node.multiplicity = n.multiplicity;
        // v2.74.361 — B-full (partial): triggers (cross-link refs clamped to the
        // allowed set, deduped, no self-ref) + presenceCondition (short string).
        if (typeof n.presenceCondition === 'string' && n.presenceCondition.trim()) {
          node.presenceCondition = n.presenceCondition.trim().slice(0, 120);
        }
        if (Array.isArray(n.triggers)) {
          const trg = [...new Set(n.triggers.filter(t => typeof t === 'string' && allowed.has(t) && t !== ref))].slice(0, 6);
          if (trg.length) node.triggers = trg;
        }
        const kids = sanitizeNodes(n.contains);
        if (kids.length) node.contains = kids;
        out.push(node);
      }
      return out;
    };
    const nodes = sanitizeNodes(parsed.nodes);
    // Completeness: append any landmark the model omitted, as a flat root.
    for (const l of list) {
      if (!seen.has(l.uid)) { nodes.push({ ref: l.uid }); seen.add(l.uid); }
    }
    const sanitizeOverlay = (arr, key) => {
      const out = [];
      for (const o of Array.isArray(arr) ? arr : []) {
        const name2 = (o && typeof o.name === 'string' && o.name.trim()) ? o.name.trim().slice(0, 60) : null;
        const members = (Array.isArray(o?.[key]) ? o[key] : []).filter(r => typeof r === 'string' && allowed.has(r));
        if (name2 && members.length) out.push({ name: name2, [key]: members });
      }
      return out;
    };
    return {
      nodes,
      groupings: sanitizeOverlay(parsed.groupings, 'members'),
      sequences: sanitizeOverlay(parsed.sequences, 'steps'),
    };
  }

  /**
   * v2.74.347 — Serialize a prior reviewed structure into a compact outline
   * for the refine path of proposePerspectiveStructure. Refs are clamped to the
   * current landmark set (`allowed`); a node whose ref was removed is dropped
   * but its children are preserved (promoted in place). Per-node/overlay
   * `authoringMetadata.userJudgment` is surfaced as a [marker] so the model
   * knows what to keep vs. re-think. Returns '' when nothing is renderable.
   * @returns {string}
   */
  static #serializePriorStructure(prior, allowed, aliasOf) {
    if (!prior || typeof prior !== 'object') return '';
    const mark = (o) => {
      const v = o?.authoringMetadata?.userJudgment;
      return (v === 'accepted' || v === 'edited' || v === 'rejected-but-kept') ? ` [${v}]` : '';
    };
    const renderNodes = (arr, depth) => {
      let out = '';
      for (const n of Array.isArray(arr) ? arr : []) {
        const ref = (n && typeof n.ref === 'string') ? n.ref : null;
        if (n && n.virtual === true && Array.isArray(n.contains)) {
          // v2.74.365 — virtual container: keep it in the refine view.
          const pad = '  '.repeat(depth);
          const role = (typeof n.role === 'string' && n.role.trim()) ? ` role=${n.role.trim()}` : '';
          const mult = (typeof n.multiplicity === 'string' && n.multiplicity.trim()) ? ` mult=${n.multiplicity.trim()}` : '';
          const pres = (typeof n.presenceCondition === 'string' && n.presenceCondition.trim()) ? ` when="${n.presenceCondition.trim()}"` : '';
          out += `${pad}- (virtual container)${role}${mult}${pres}${mark(n)}\n`;
          out += renderNodes(n.contains, depth + 1);
          continue;
        }
        if (ref && allowed.has(ref)) {
          const pad  = '  '.repeat(depth);
          const role = (typeof n.role === 'string' && n.role.trim()) ? ` role=${n.role.trim()}` : '';
          const mult = (typeof n.multiplicity === 'string' && n.multiplicity.trim()) ? ` mult=${n.multiplicity.trim()}` : '';
          const trg  = (Array.isArray(n.triggers) && n.triggers.length) ? ` triggers=[${n.triggers.map(t => aliasOf.get(t) ?? t).join(', ')}]` : '';
          const pres = (typeof n.presenceCondition === 'string' && n.presenceCondition.trim()) ? ` when="${n.presenceCondition.trim()}"` : '';
          out += `${pad}- ref: ${ref} (${aliasOf.get(ref) ?? '?'})${role}${mult}${trg}${pres}${mark(n)}\n`;
          if (Array.isArray(n.contains)) out += renderNodes(n.contains, depth + 1);
        } else if (n && Array.isArray(n.contains)) {
          out += renderNodes(n.contains, depth);   // ref gone → promote children
        }
      }
      return out;
    };
    const renderOverlay = (arr, key, label) => {
      let out = '';
      for (const o of Array.isArray(arr) ? arr : []) {
        const name = (o && typeof o.name === 'string' && o.name.trim()) ? o.name.trim() : null;
        const members = (Array.isArray(o?.[key]) ? o[key] : []).filter(r => typeof r === 'string' && allowed.has(r));
        if (name && members.length) out += `- ${label} ${name}: ${members.map(r => aliasOf.get(r) ?? r).join(', ')}${mark(o)}\n`;
      }
      return out;
    };
    const nodes = renderNodes(prior.nodes, 0);
    const grp   = renderOverlay(prior.groupings, 'members', 'grouping');
    const seq   = renderOverlay(prior.sequences, 'steps', 'sequence');
    let block = '';
    if (nodes) block += `nodes:\n${nodes}`;
    if (grp)   block += `groupings:\n${grp}`;
    if (seq)   block += `sequences:\n${seq}`;
    return block.trim();
  }

  /**
   * v2.74.348 — PERSPECTIVE_SPEC § 13 / § 16 priority 6: the description-first,
   * LLM-mediated PROPOSAL flow. Given the user's INTENT (the Perspective
   * description) and the current page, propose 2–3 PERSPECTIVE OPTIONS — each
   * a named set of landmark ROLES to fill (NOT concrete selectors; the user
   * picks the real elements) plus suggested URL-applicability predicates and a
   * one-line rationale. This is the inverse of suggestPerspective (page-seeded,
   * concrete landmarks) — it is intent-seeded and role-scaffolded, per the
   * canonical "LLM as proposal layer, user as committer" pattern.
   *
   * v2.74.350 — Optional ENHANCED context (the benchmark's B arm). All three
   * are additive — when omitted the call is byte-identical to the baseline, so
   * an A/B isolates the value of the added context, holding the DOM constant:
   *   - screenshot:        data:image/...;base64 of the visible page (multimodal
   *                        grounding for layout / prominence / repetition).
   *   - siblingPerspectives:    [{ name, description, roles[] }] already on this
   *                        Ground — avoid duplicates, reuse role vocabulary.
   *   - registryLandmarks: [{ alias, a11yRole, description }] already captured
   *                        on this Ground — roles may map to existing landmarks.
   *
   * @param {{ intent: string, url?: string, title?: string, domSnapshot?: string, screenshot?: string|null, siblingPerspectives?: Array|null, registryLandmarks?: Array|null }} params
   * @returns {Promise<{ options: Array<{name:string, rationale:string, onPage:boolean, reachedVia:string|null, roles:Array<{role:string,description:string,multiplicity:string}>, predicates:Array<{kind:'urlMatches',pattern:string,mode:string}>}> }|null>}
   */
  static async proposePerspectives({ intent, url, title, domSnapshot, screenshot = null, siblingPerspectives = null, registryLandmarks = null, locale = null, targetGoalId = null, groundedIntent = null, formFields = null, intentSpecHint = null }) {
    const seed = (typeof intent === 'string' ? intent : '').trim();
    if (!seed) return null;

    // PB-1 (DESIGN_phaseB_pipeline R3): ordered list of feature ids the LLM grounds roles to via a
    // `featureIndex`. Built below from the Locale catalog; the array index === the number shown to
    // the model, and maps back to a real featureId in the sanitizer (mirrors synthesizeGoals).
    const featureRefList = [];

    // PB-10 — extract the intent's parameters and ASSEMBLE the proposal directive from them (this
    // replaces the static "minimal roles / 2-4 options" prior, which forced completion intents like
    // "apply for this job" to shard into sub-region perspectives). `formFields` (the content-script form
    // oracle, when present) supplies the must-cover REQUIRED-field labels so the directive can name them.
    const requiredFieldLabels = Array.isArray(formFields)
      ? formFields.filter((f) => f && f.required && !f.isSubmit).map((f) => f.label).filter(Boolean)
      : [];
    const _hasSubmit = Array.isArray(formFields) ? formFields.some((f) => f && f.isSubmit) : false;
    const intentSpec = deriveIntentSpec(seed, {
      groundedIntent,
      requiredFieldCount: requiredFieldLabels.length, hasSubmit: _hasSubmit, requiredFieldLabels,
      // PB-10 extractor upgrade: LLM-emitted shape/completeness from groundIntent (primary when present).
      llmShape: intentSpecHint?.shape ?? null,
      llmCompleteness: intentSpecHint?.completeness ?? null,
    });
    const proposeDirective = buildProposeDirective(intentSpec);
    // Role cap is intent-driven too: a completion form legitimately needs many roles (the old fixed
    // cap of 10 truncated "apply for this job" mid-form). Minimal intents keep a tight ceiling.
    const roleCap = intentSpec.completeness === 'exhaustive' ? 60 : 10;
    // PB-10 binding — map each required-field LABEL → its real control {selector, kind}. A role the LLM
    // tags with "field":"<label>" binds DIRECTLY to that selector (skips the wrapper-guessing resolver),
    // so INSPECT lands on the real input → correct TYPE/SELECT/CLICK. Also used to dedup the backfill.
    const _normLabel = (s) => String(s || '').replace(/\s*\*\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const requiredByLabel = new Map();
    if (Array.isArray(formFields)) {
      for (const f of formFields) {
        if (f && (f.required || f.isSubmit) && f.label) {
          requiredByLabel.set(_normLabel(f.label), { selector: f.selector || null, kind: f.kind || (f.isSubmit ? 'submit' : 'input') });
        }
      }
    }

    const systemPrompt = `You propose PERSPECTIVE OPTIONS for a web-automation "Perspective" (a reusable "kind of page" view). You are given the user's INTENT (what they want to do) and the current page. Propose 2-3 distinct perspectives that serve the intent on this page.

A perspective is a NAMED set of landmark ROLES — abstract slots the user will fill by picking real page elements. You do NOT pick elements or write selectors; you name the roles and describe what fills each.

Return ONLY a JSON object:
{
  "options": [
    {
      "name": "search-results",
      "rationale": "one sentence: why this perspective fits the intent and this page",
      "onPage": true,
      "reachedVia": null,
      "roles": [
        { "role": "search-input", "description": "the text box where the query is typed", "multiplicity": "one", "featureIndex": 0 },
        { "role": "result-item",  "description": "a single result row in the list",        "multiplicity": "many", "featureIndex": 4 },
        { "role": "login-trigger", "description": "the 'Log in' button that opens the auth modal", "multiplicity": "one" },
        { "role": "google-signin", "description": "the Google sign-in button inside the modal", "multiplicity": "one", "hidden": true, "revealedBy": "login-trigger" }
      ],
      "predicates": [
        { "kind": "urlMatches", "pattern": "/search", "mode": "contains" }
      ]
    }
  ]
}

Rules:
${proposeDirective}
- "name" = short kebab-case identifier for the perspective ("search-results", "product-detail", "checkout-form").
- "roles" = "role" is a short kebab-case semantic name; "description" says what element fills it (so the user knows what to pick); "multiplicity" is one | many | optional. "field" (optional) = the verbatim label of the required form field this role fills, when a required-field list is given below.
- FEATURE GROUNDING (important): a numbered FEATURE REFERENCE list may be attached below (real page features already enumerated + verified by exploration). For EACH role, set "featureIndex" to the NUMBER of the feature that fills it — the element the user will act on. Use -1 ONLY if no listed feature matches (the role is then unbound and the user picks it manually). A grounded role reuses a real, verified element instead of a guessed selector, so ground every role you can. Hidden roles still get a featureIndex if their revealed element is listed.
- HIDDEN roles: for a role whose element appears ONLY after an interaction (inside a dropdown menu, a modal, an expanded panel), set "hidden": true and "revealedBy": the role name (within THIS perspective's roles) of the control that reveals it. That revealing control MUST itself be one of the roles (e.g. a "login-trigger" role), and you must list the trigger role BEFORE the role(s) it reveals. This lets the resolver open the trigger and find the hidden element. (On-page trigger + hidden children all stay onPage:true.)
- Roles describe FUNCTION, not appearance ("primary-action", "result-item" — not "blue-button", "div-3").
- "predicates" (optional) = ONLY urlMatches entries that declare where this perspective applies. "pattern" is a URL substring/regex/exact string; "mode" is contains | exact | regex. Do NOT propose landmark-based predicates — the landmarks don't exist yet. Omit predicates if no reliable URL signal.
- "onPage" = true if THIS perspective's elements are present on the CURRENT page you are analyzing; false if it belongs to a DOWNSTREAM page reached only AFTER acting (e.g., the results page that appears after submitting a search, or a detail page after clicking a result). Judge this from the actual page content/screenshot.
- DEPTH IS NOT DOWNSTREAM. Content revealed by an interaction on the SAME page — a dropdown menu, a modal/dialog, an expanded panel, an accordion, a tab — stays on the current page (the URL does not change). That is in-page DEPTH: keep onPage:true and model it with hidden/revealedBy roles (below). "downstream" (onPage:false) means a DIFFERENT page you NAVIGATE to (the URL changes). A login MODAL that opens over this page is depth (onPage:true); a separate login PAGE is downstream (onPage:false).
- "reachedVia" = for a downstream perspective (onPage:false), a SHORT phrase for how you reach it from the current page ("after submitting the search", "after clicking a result"). null for on-page perspectives.
- List the on-page perspective(s) FIRST. You MAY include downstream perspectives that complete the intent's journey, but mark them onPage:false — the user can only fill a perspective's roles once they are on its page.
- Favor the intent. If the intent is narrow ("capture search results"), don't propose unrelated perspectives.
- DEPTH: a PAGE DEPTH map may be attached — it lists disclosure controls (dropdowns, menus, modals, tabs, accordions) and the elements each one REVEALED. This content is NOT in the static DOM listing because it only appears after an interaction. Treat revealed elements as first-class: propose roles for them too, and in the role "description" say how it is revealed (e.g., "an item in the account menu, revealed after clicking the avatar"). These stay onPage:true (same page, just disclosed) — onPage:false is only for content reached by NAVIGATING away.
- A PAGE FEATURE CATALOG may be attached — the WHOLE-PAGE inventory of interactive features (inputs / actions / disclosures / navigation) and content collections (repeating cards/tiles/rows) actually enumerated on the page, INCLUDING off-screen ones the static DOM/screenshot miss. This is the page's real affordances: GROUND your perspectives in it. Prefer roles that MAP to catalogued features, and align role names with the catalogued labels. A multiplicity:"many" content role usually maps to a "collection" entry; a "disclosure" entry is a trigger you can model with hidden/revealedBy roles.`;

    // Base context — identical in baseline and enhanced runs, so the A/B
    // measures the ADDED context (screenshot + library) holding the DOM fixed.
    let userText = `Intent: ${seed}\nURL: ${url ?? '(unknown)'}\nTitle: ${title ?? '(unknown)'}\n\nPage (sanitized DOM):\n${(domSnapshot ?? '').slice(0, 12000)}`;

    // Enhanced — perspectives already on this Ground: avoid duplicating them,
    // prefer complementary ones, and reuse their role vocabulary.
    if (Array.isArray(siblingPerspectives) && siblingPerspectives.length) {
      const block = siblingPerspectives.slice(0, 12).map(l => {
        const roles = (Array.isArray(l?.roles) && l.roles.length) ? ` — roles: ${l.roles.join(', ')}` : '';
        const desc  = l?.description ? `: ${String(l.description).slice(0, 120)}` : '';
        return `- ${l?.name ?? '(unnamed)'}${desc}${roles}`;
      }).join('\n');
      userText += `\n\nPERSPECTIVES ALREADY ON THIS GROUND (do NOT re-propose one of these — prefer COMPLEMENTARY perspectives; reuse these role names where the same kind of element recurs, for a consistent library):\n${block}`;
    }

    // Enhanced — landmark registry: a role may map to an already-captured
    // landmark (reuse, per the substrate's many-to-many sharing).
    if (Array.isArray(registryLandmarks) && registryLandmarks.length) {
      const block = registryLandmarks.slice(0, 30).map(lm => {
        const role = lm?.a11yRole ? ` [${lm.a11yRole}]` : '';
        const d    = lm?.description ? ` — ${String(lm.description).slice(0, 80)}` : '';
        return `- ${lm?.alias ?? '(no-alias)'}${role}${d}`;
      }).join('\n');
      userText += `\n\nLANDMARKS ALREADY CAPTURED ON THIS GROUND (these elements exist and can be reused; align role names with them where the same element recurs):\n${block}`;
    }

    // v2.74.426 — #2 P2: DEPTH now comes from the Locale's LAYERS (the poke→reveal
    // sweep is folded into the Locale during Explore), not a separate pageStructure
    // artifact. Each non-surface layer = a disclosure trigger + the elements it
    // reveals. The flat feature catalog (below) doesn't convey these REVEAL
    // relationships, so render them explicitly so the author can propose roles for
    // post-interaction landmarks the static DOM can't show.
    if (locale && locale.layers && locale.features) {
      const layers = Object.values(locale.layers).filter(l => l && l.kind !== 'surface' && Array.isArray(l.features) && l.features.length);
      if (layers.length) {
        const block = layers.slice(0, 16).map(l => {
          const trig = l.openedBy ? locale.features[l.openedBy] : null;
          const head = `▸ "${((trig?.label || trig?.a11yRole || 'control')).slice(0, 50)}" [${l.kind}] reveals:`;
          const kidIds = l.features.slice(0, 12);
          const kids = kidIds.map(fid => { const f = locale.features[fid]; return `    • "${(f?.label || '').slice(0, 50)}" [${f?.a11yRole || f?.kind || '?'}]`; }).join('\n');
          const more = l.features.length > 12 ? `\n    • …(+${l.features.length - 12} more)` : '';
          return `${head}\n${kids}${more}`;
        }).join('\n');
        userText += `\n\nPAGE DEPTH (interactions that REVEAL hidden content — these elements are NOT in the static DOM above; propose roles for them and note how each is revealed, e.g. "an item in the account menu, revealed after clicking the avatar"):\n${block}`;
      }
    }

    // v2.74.403 — Whole-page feature catalog (the Locale / Perspective capability
    // model). Grounds perspectives in the page's REAL affordances — including
    // off-screen features the static DOM/screenshot miss — so roles MAP to
    // catalogued features instead of being guessed. (PAGEMODEL_SPEC § 6, § 7.)
    if (locale && locale.features) {
      const feats = locale.features;
      const byKind = locale.index?.byKind || {};
      const order = ['input', 'action', 'disclosure', 'navigation', 'collection', 'region'];
      const lines = [];
      for (const k of order) {
        const cap = (k === 'navigation') ? 30 : 16;
        const ids = (byKind[k] || []).slice(0, cap);
        const items = ids.map((id) => {
          const f = feats[id]; if (!f) return null;
          const lbl = (f.label || '(no label)').toString().slice(0, 40);
          const mem = f.members ? ` ×${f.members.count}` : '';
          return `"${lbl}"${mem}`;
        }).filter(Boolean);
        const more = (byKind[k] || []).length > cap ? ` …(+${(byKind[k] || []).length - cap})` : '';
        if (items.length) lines.push(`  ${k}: ${items.join(', ')}${more}`);
      }
      if (lines.length) {
        userText += `\n\nPAGE FEATURE CATALOG (whole-page inventory, incl. off-screen — propose roles that MAP to these; "many" content roles → a collection entry; a disclosure entry is a trigger):\n${lines.join('\n')}`;
      }
      // v2.74.410 — PAGE GOALS (L2): the page's outcomes + the features that
      // achieve each. The intent usually maps to ONE goal; build the perspective's
      // roles around THAT goal's features. (Intent → goal → features → roles.)
      if (locale.goals && Object.keys(locale.goals).length) {
        const gl = Object.values(locale.goals).slice(0, 10).map((g) => {
          const fl = (g.achievableVia || []).map((fid) => feats[fid]?.label).filter(Boolean).slice(0, 8);
          return `- ${g.label}${g.description ? `: ${String(g.description).slice(0, 100)}` : ''}${fl.length ? ` → [${fl.join(', ')}]` : ''}`;
        }).join('\n');
        if (gl) userText += `\n\nPAGE GOALS (outcomes this page supports + the features that achieve each — identify which goal the INTENT targets and build the perspective's roles around THAT goal's features):\n${gl}`;
      }
      // PB-1 (R3): numbered FEATURE REFERENCE the model grounds each role to via "featureIndex".
      // Target-goal features lead the list (lowest indices = most relevant), then the rest by kind,
      // deduped, capped. featureRefList[i] === featureId, so the sanitizer maps featureIndex → id.
      const seen = new Set();
      const pushRef = (id) => { if (feats[id] && !seen.has(id)) { seen.add(id); featureRefList.push(id); } };
      const tgGoal = targetGoalId && locale.goals ? locale.goals[targetGoalId] : null;
      if (tgGoal && Array.isArray(tgGoal.achievableVia)) tgGoal.achievableVia.forEach(pushRef);
      for (const k of order) {
        for (const id of (byKind[k] || [])) { if (featureRefList.length >= 80) break; pushRef(id); }
      }
      if (featureRefList.length) {
        const refLines = featureRefList.map((id, i) => {
          const f = feats[id];
          const lbl = (f.label || '(no label)').toString().slice(0, 40);
          const mem = f.members ? ` ×${f.members.count}` : '';
          return `${i}. "${lbl}" [${f.kind || '?'}]${mem}`;
        }).join('\n');
        const focus = tgGoal ? ` The intent targets goal "${tgGoal.label}" — its features lead the list.` : '';
        userText += `\n\nFEATURE REFERENCE (set each role's "featureIndex" to a NUMBER below; -1 if none match).${focus}\n${refLines}`;
      }
    }

    // Enhanced — screenshot as the first content block (layout / prominence /
    // repetition signal the text DOM can't convey).
    const userContent = [];
    let imageNote = '';
    if (typeof screenshot === 'string') {
      const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(screenshot);
      if (m) {
        userContent.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
        imageNote = '\n\n(A screenshot of the current page is attached above — use it to judge layout, visual prominence, and which elements repeat.)';
      }
    }
    userContent.push({ type: 'text', text: userText + imageNote });
    const enhanced = userContent.length > 1
      || (Array.isArray(siblingPerspectives) && siblingPerspectives.length)
      || (Array.isArray(registryLandmarks) && registryLandmarks.length);

    Logger.info('AnthropicService', `proposePerspectives [${enhanced ? 'enhanced' : 'baseline'}] — intent="${seed.slice(0, 60)}" shape=${intentSpec.shape}/${intentSpec.completeness} via=${intentSpec.decidedBy} cardinality=${intentSpec.cardinality.min}-${intentSpec.cardinality.max} mustCover=${intentSpec.mustCover.length}`);

    let parsed;
    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 1800, [], { role: 'propose', operation: 'proposePerspectives' });
      if (!raw?.success) {
        Logger.warn('AnthropicService', `proposePerspectives failed: ${raw?.error}`);
        return null;
      }
      const json = AnthropicService.#firstJsonObject(raw.text);
      if (!json) { Logger.warn('AnthropicService', 'proposePerspectives: no JSON'); return null; }
      parsed = JSON.parse(json);
    } catch (e) {
      Logger.warn('AnthropicService', `proposePerspectives error: ${e.message}`);
      return null;
    }

    // ── Safety sanitizer ──────────────────────────────────────────────
    const MULT = new Set(['one', 'many', 'optional', 'conditional']);
    const MODE = new Set(['contains', 'exact', 'regex']);
    const kebab = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const options = [];
    for (const o of Array.isArray(parsed.options) ? parsed.options : []) {
      const name = kebab(o?.name);
      const roles = [];
      for (const r of Array.isArray(o?.roles) ? o.roles : []) {
        const role = kebab(r?.role);
        if (!role) continue;
        if (roles.some(x => x.role === role)) continue;   // dedup within option
        // PB-1 (R3): map the model's featureIndex → a real featureId via featureRefList. Out-of-range
        // / -1 / absent → null (role unbound; resolve falls back to LLM/visual + the user picks).
        const fi = Number.isInteger(r?.featureIndex) ? r.featureIndex : -1;
        const featureId = (fi >= 0 && fi < featureRefList.length) ? featureRefList[fi] : null;
        // PB-10 — if the role claims a required field ("field":"<label>"), bind it to that field's real
        // control selector + kind (the oracle), so resolve skips the wrapper-guessing LLM.
        const fieldTag = (typeof r?.field === 'string' && r.field.trim()) ? r.field.trim().slice(0, 160) : null;
        const bound = fieldTag ? requiredByLabel.get(_normLabel(fieldTag)) : null;
        roles.push({
          role,
          description: (typeof r?.description === 'string' ? r.description.trim() : '').slice(0, 160),
          multiplicity: MULT.has(r?.multiplicity) ? r.multiplicity : 'one',
          // v2.74.381 — depth linkage for reveal-aware resolve.
          hidden: r?.hidden === true,
          revealedBy: (typeof r?.revealedBy === 'string' && r.revealedBy.trim()) ? kebab(r.revealedBy) : null,
          // PB-1 — grounded element (resolve-by-reuse target) or null when unmapped.
          featureId,
          // PB-10 — oracle form-field binding (real control) + which required field this role claims.
          field: fieldTag,
          selector: bound?.selector || null,
          fieldKind: bound?.kind || null,
        });
        if (roles.length >= roleCap) break;
      }
      // Drop revealedBy references that don't point to a real role in this option.
      for (const rr of roles) { if (rr.revealedBy && !roles.some(x => x.role === rr.revealedBy)) { rr.revealedBy = null; } }
      if (!name || roles.length === 0) continue;           // an option needs a name + ≥1 role
      const predicates = [];
      for (const p of Array.isArray(o?.predicates) ? o.predicates : []) {
        if (p?.kind !== 'urlMatches') continue;
        const pattern = (typeof p?.pattern === 'string' ? p.pattern.trim() : '');
        if (!pattern) continue;
        predicates.push({ kind: 'urlMatches', pattern: pattern.slice(0, 300), mode: MODE.has(p?.mode) ? p.mode : 'contains' });
        if (predicates.length >= 4) break;
      }
      // onPage: default true when absent (treat as fillable rather than
      // hiding it). reachedVia only meaningful for downstream perspectives.
      const onPage = o?.onPage !== false;
      const reachedVia = (!onPage && typeof o?.reachedVia === 'string' && o.reachedVia.trim())
        ? o.reachedVia.trim().slice(0, 120) : null;
      options.push({
        name,
        rationale: (typeof o?.rationale === 'string' ? o.rationale.trim() : '').slice(0, 240),
        onPage,
        reachedVia,
        roles,
        predicates,
      });
      if (options.length >= 4) break;
    }

    // PB-10 completeness backfill — the form oracle reads the FULL DOM (no viewport/scroll limit), so for
    // an exhaustive completion intent it is authoritative for the role SET. Append any required field the
    // LLM omitted — below-the-fold fields it couldn't see in the (viewport-only) screenshot, or fields the
    // model just dropped — to the primary on-page option. Coverage becomes guaranteed by construction.
    if (intentSpec.completeness === 'exhaustive' && Array.isArray(formFields) && formFields.length && options.length) {
      const primary = options.find((o) => o.onPage !== false) || options[0];
      // Coverage = required labels a role claimed via "field" (EXACT — no fuzzy dup) UNION roles whose
      // name fuzzily matches the field slot (catches roles that omitted the tag). Both directions guard
      // against re-adding a field the LLM already covers (the screening-question duplicate bug).
      const claimed = new Set(primary.roles.map((r) => (r.field ? _normLabel(r.field) : null)).filter(Boolean));
      const haveNames = primary.roles.map((r) => r.role);
      let added = 0;
      for (const f of selectNecessaryFields(formFields)) {
        if (primary.roles.length >= roleCap) break;
        if (claimed.has(_normLabel(f.label)) || haveNames.some((n) => slugMatch(n, f.slot))) continue;
        if (primary.roles.some((x) => x.role === f.slot)) continue;
        if (f.kind === 'file' && primary.roles.some((x) => /resume|cv|upload|file|attach/i.test(x.role))) continue;
        primary.roles.push({
          role: f.slot.slice(0, 60),
          description: (f.isSubmit ? `Submit/commit control ("${f.label || 'Submit'}")` : `Required field: ${f.label || f.slot}`).slice(0, 160),
          multiplicity: 'one',
          hidden: false,
          revealedBy: null,
          featureId: null,
          field: f.label || null,
          selector: f.selector || null,   // PB-10 — bind backfilled field to its real control too
          fieldKind: f.kind || null,
          oracleBackfill: true,
        });
        added++;
      }
      if (added) Logger.info('AnthropicService', `proposePerspectives: oracle backfilled ${added} required field(s) the proposal missed`);
    }

    if (options.length === 0) return null;
    return { options };
  }

  /**
   * v2.74.368 — "Plan page exploration": given the enumerated disclosure
   * CANDIDATES on a page (controls likely to reveal hidden content), pick a
   * budget-limited subset worth ACTIVATING. The content-script sweep then pokes
   * only those, so we spend the poke budget on controls that expose structural
   * depth (menus, modals, tab panels, accordions) instead of every toggle.
   *
   * The `plan` role: Claude judges which interactions to perform; the system
   * still verifies what each reveal produces (the sweep is deterministic). A
   * bad pick wastes a poke, never corrupts the artifact. Returns selectors that
   * MUST be members of the supplied candidate set (others are dropped).
   *
   * @param {{ url?:string, title?:string, candidates: Array<{selector:string,role?:string,label?:string,expanded?:string|null,haspopup?:string|null,safe?:boolean}>, screenshot?:string|null, maxPokes?:number }} params
   * @returns {Promise<{ plan: string[], reasons: Record<string,string> }|null>}
   */
  static async planPageExploration({ url, title, candidates, screenshot = null, maxPokes = 12 }) {
    const cand = (Array.isArray(candidates) ? candidates : []).filter(c => c && typeof c.selector === 'string' && c.selector);
    if (cand.length === 0) return null;
    const budget = Math.max(1, Math.min(24, Number.isFinite(maxPokes) ? maxPokes : 12));

    const systemPrompt = `You plan a DISCLOSURE-EXPLORATION sweep of a web page. You are given a SCREENSHOT and a numbered list of candidate CONTROLS. The list is a deliberately BROAD net — every safe, plausibly-interactive element — so MANY entries will be irrelevant (plain links, list items, decorative buttons). YOU are the precision filter: use the screenshot + each control's position (rect) + label/hint to pick the ones that, when activated, will REVEAL hidden structure (dropdowns, menus, modals, tabs, accordions, carousels, "show more", filter panels). The system then ACTIVATES the ones you pick (hover + click), observes what becomes visible, and restores the page. Spend a limited budget on the controls most likely to expose STRUCTURAL DEPTH the static page can't show.

Return ONLY a JSON object:
{ "plan": [ { "index": 3, "reason": "account menu — likely reveals nav links" } ] }

Rules:
- Pick UP TO ${budget} controls, by their "index" in the list. USE THE BUDGET: when several distinct controls could each reveal something (a nav/account menu, a category dropdown, a carousel, a tab strip, a filter panel), include them all up to the limit — don't return just one or two unless the page truly has only that. Poking a DISCLOSURE is reversible (the menu/panel is restored) and navigation is blocked — so err toward INCLUDING the plausibly-revealing ones — BUT never pick a control that ACTS rather than reveals (see the side-effect rule below).
- NEVER poke a control that performs a SIDE-EFFECT ACTION instead of disclosing structure: download, save / bookmark, like / favorite, add-to-cart / buy / checkout / pay / place-order, delete / remove, send, submit, share, follow, upload, log out / sign out, deactivate / unsubscribe / close-account, publish, or withdraw / transfer funds. These mutate real server or session state irreversibly and the restore step does NOT undo them — exploring is for DISCLOSING structure, never for committing actions. The restore step does NOT undo these and the nav guard does NOT block them — a download will actually SAVE A FILE to the user's machine; a "like" mutates real state. This includes TERMINAL CHOICES inside a revealed menu (e.g. a "Download → Original / Large / Medium / Small" size option, an "Add to playlist" item). A control that merely OPENS such a menu is only worth poking if you can see it reveals navigational/structural depth — when in doubt whether a control REVEALS vs ACTS, SKIP it.
- The screenshot is your STRONGEST signal — a control drawn with a ▾ chevron / caret / arrow, or that visually looks like a menu/dropdown/tab, should be picked regardless of how its hint reads (hints come from imperfect markup; what you SEE is more reliable).
- Each control has a "hint" tag: labeled-icon, icon, arrow-glyph, chevron, haspopup, aria-expanded, aria-controls, combobox, tab, menuitem, data-toggle, keyword, clickable (clickable = matched the broad net but no specific affordance — judge it from the screenshot).
  • hint=labeled-icon is the classic "Label ▾" DROPDOWN BUTTON ("Explore ▾", "Sort by ▾", "Filters ▾") — these almost always open a useful menu/modal. ALWAYS include them.
  • hint=icon / arrow-glyph / icon-only with an EMPTY label are bare icon controls (menu/dropdown/carousel arrows); the 'near "…"' text says what they relate to. Prefer them; don't skip for lacking a label.
- Prefer controls that reveal NAVIGATION, distinct SECTIONS, or MORE SELECTABLE OPTIONS — account/profile menus, hamburger nav, category/"Explore" dropdowns, filter panels, modal openers, tab strips, accordions, AND carousels/sliders (advancing a carousel surfaces additional selectable items that aren't otherwise reachable).
- SKIP: duplicates of a control you already picked, pure cosmetic toggles (dark mode, mute, play/pause), and controls marked safe=false.
- IMPORTANT — skip controls that NAVIGATE to another page rather than reveal content in place: a site logo/home, breadcrumb links, "see more / view all" links, category links that load a new page, pagination. Poking those leaves the page. Prefer controls that DISCLOSE in place (a menu/modal/panel/tab/accordion/carousel opens without leaving). A control that opens a sign-in/sign-up MODAL is good (it discloses); one that goes to a separate login PAGE is not.
- "reason" = a short phrase (why this control is worth opening).
- If genuinely nothing is worth poking, return { "plan": [] }.`;

    const lines = cand.slice(0, 120).map((c, i) => {
      const flags = [c.hint ? `hint=${c.hint}` : '', c.expanded != null ? `expanded=${c.expanded}` : '', c.haspopup ? `haspopup=${c.haspopup}` : '', c.safe === false ? 'safe=false' : ''].filter(Boolean).join(' ');
      const label = String(c.label || '').slice(0, 60);
      const ctx = (!label && c.context) ? ` near "${String(c.context).slice(0, 50)}"` : '';
      return `${i}. [${c.role || '?'}] "${label}"${ctx}${flags ? ` (${flags})` : ''}`;
    }).join('\n');
    let userText = `URL: ${url ?? '(unknown)'}\nTitle: ${title ?? '(unknown)'}\nBudget: ${budget} pokes\n\nCANDIDATE CONTROLS:\n${lines}`;

    const userContent = [];
    if (typeof screenshot === 'string') {
      const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(screenshot);
      if (m) { userContent.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }); userText += '\n\n(A screenshot of the page is attached — use it to judge which controls are prominent / structural.)'; }
    }
    userContent.push({ type: 'text', text: userText });

    Logger.info('AnthropicService', `planPageExploration — ${cand.length} candidates, budget ${budget}`);
    let parsed;
    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 700, [], { role: 'plan', operation: 'planPageExploration' });
      if (!raw?.success) { Logger.warn('AnthropicService', `planPageExploration failed: ${raw?.error}`); return null; }
      const json = AnthropicService.#firstJsonObject(raw.text);
      if (!json) { Logger.warn('AnthropicService', 'planPageExploration: no JSON'); return null; }
      parsed = JSON.parse(json);
    } catch (e) {
      Logger.warn('AnthropicService', `planPageExploration error: ${e.message}`);
      return null;
    }

    const plan = [];
    const reasons = {};
    for (const p of Array.isArray(parsed?.plan) ? parsed.plan : []) {
      const idx = Number(p?.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cand.length) continue;
      const sel = cand[idx].selector;
      if (plan.includes(sel)) continue;
      if (cand[idx].safe === false) continue;                 // never plan an unsafe control
      plan.push(sel);
      if (typeof p?.reason === 'string' && p.reason.trim()) reasons[sel] = p.reason.trim().slice(0, 120);
      if (plan.length >= budget) break;
    }
    return { plan, reasons };
  }

  /**
   * v2.74.393 — Page-affordance description. Given the explored page's surface +
   * disclosures, describe (plain text) WHAT KINDS OF GOALS a user can accomplish
   * here. Intent-INDEPENDENT, so it's generated once during Explore and cached
   * in the pageStructure artifact; `groundIntent` reuses it to anchor a user's
   * raw intent in the page's real capabilities.
   * @returns {Promise<string|null>}
   */
  static async describePageAffordances({ url, title, surface, controls, screenshot = null }) {
    const surf = (Array.isArray(surface) ? surface : []).map(s => (s?.label || s?.role || '').toString().trim()).filter(Boolean);
    const uniqSurf = [...new Set(surf)].slice(0, 120);
    const ctrlLines = (Array.isArray(controls) ? controls : [])
      .filter(c => c?.observation === 'reveal' && Array.isArray(c.revealed) && c.revealed.length)
      .slice(0, 16)
      .map(c => `- "${(c.label || c.role || 'control').slice(0, 40)}" reveals: ${c.revealed.slice(0, 8).map(r => `"${(r.label || '').slice(0, 30)}"`).join(', ')}`);
    if (!uniqSurf.length && !ctrlLines.length) return null;

    const systemPrompt = `You describe a web page for an automation-authoring tool. Given the page's interactive SURFACE (visible controls/links) and its DISCLOSURES (controls that reveal hidden menus/modals when activated), describe WHAT KINDS OF GOALS a user can accomplish on THIS kind of page.

Return PLAIN TEXT (no JSON, no markdown headers), ~4-8 sentences:
- What kind of page this is / its purpose.
- The distinct GOALS achievable here (e.g. "search for media", "sign in / sign up", "filter by media type", "browse curated collections") — grounded in the ACTUAL surface + disclosures, not generic boilerplate.
- For each goal, the key affordance(s) that enable it (the control/region a user would use).
Be specific to what is actually present; do not invent capabilities that aren't represented in the surface/disclosures.`;

    let text = `URL: ${url ?? '(unknown)'}\nTitle: ${title ?? '(unknown)'}\n\nVISIBLE SURFACE (controls/links):\n${uniqSurf.map(s => `- ${s}`).join('\n').slice(0, 4000)}`;
    if (ctrlLines.length) text += `\n\nDISCLOSURES (revealed by interaction):\n${ctrlLines.join('\n').slice(0, 3000)}`;
    const userContent = [];
    if (typeof screenshot === 'string') { const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(screenshot); if (m) { userContent.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }); text += '\n\n(A screenshot of the page top is attached.)'; } }
    userContent.push({ type: 'text', text });

    Logger.info('AnthropicService', `describePageAffordances — ${url}`);
    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 700, [], { role: 'describe', operation: 'describePageAffordances' });
      if (!raw?.success) { Logger.warn('AnthropicService', `describePageAffordances failed: ${raw?.error}`); return null; }
      const t = String(raw.text ?? '').trim();
      return t ? t.slice(0, 1600) : null;
    } catch (e) { Logger.warn('AnthropicService', `describePageAffordances error: ${e.message}`); return null; }
  }

  /**
   * v2.74.408 — L2 goal synthesis (PAGEMODEL_SPEC § 5, § 8). Given a built
   * Locale (L0 features + L1 depth), identify the distinct GOALS a user can
   * accomplish, each linked to the catalogued features that realize it. The model
   * is presented as an INDEXED catalog (balanced per-kind so footer-link spam
   * can't crowd out inputs/actions); the LLM references feature INDEXES, which the
   * caller maps back to feature ids — robust vs. having it copy cryptic ids.
   * @returns {Promise<{ goals: Array<{label:string, description:string, achievableVia:string[]}> }|null>}
   */
  static async synthesizeGoals({ model, url, title, affordances = null }) {
    if (!model || !model.features) return null;
    const feats = model.features;
    const byKind = model.index?.byKind || {};
    // Balanced selection: all inputs/disclosures/collections; capped actions/nav.
    const take = (kind, cap) => (byKind[kind] || []).map(id => feats[id]).filter(f => f && (f.label || '').trim()).slice(0, cap);
    const picked = [
      ...take('input', 20), ...take('disclosure', 20), ...take('collection', 12),
      ...take('action', 24), ...take('navigation', 28),
    ].slice(0, 90);
    if (picked.length < 2) return null;
    const list = picked.map((f, i) => `[${i}] "${(f.label || '').slice(0, 50)}" (${f.kind}${f.members ? ` ×${f.members.count}` : ''}${f.hidden ? ', revealed' : ''})`).join('\n');

    const systemPrompt = `You identify the distinct GOALS a user can accomplish on a web page, given its FEATURE CATALOG (the interactive features + content collections actually found on the page, including ones revealed by interaction).

Return ONLY a JSON object:
{ "goals": [ { "label": "search for media", "description": "one sentence", "featureIndexes": [0, 5] } ] }

Rules:
- 3-8 goals. Each is a COHERENT user OUTCOME (e.g. "search for images", "sign in", "browse curated collections", "filter by media type", "download or edit an image"), NOT a single control.
- "featureIndexes" = indexes (from the list below) of the features that realize the goal — the input(s)/control(s)/collection a user would actually use. Use ONLY indexes present in the list.
- GROUND goals in the actual catalog; do not invent capabilities not represented. Prefer goals an automation author would target.`;
    let text = `URL: ${url ?? '(unknown)'}\nTitle: ${title ?? '(unknown)'}`;
    if (affordances) text += `\n\nPage summary:\n${String(affordances).slice(0, 1000)}`;
    text += `\n\nFEATURE CATALOG (index: "label" (kind)):\n${list}`;

    Logger.info('AnthropicService', `synthesizeGoals — ${picked.length} features, ${url}`);
    try {
      const raw = await AnthropicService.#call(systemPrompt, [{ type: 'text', text }], 800, [], { role: 'describe', operation: 'synthesizeGoals' });
      if (!raw?.success) { Logger.warn('AnthropicService', `synthesizeGoals failed: ${raw?.error}`); return null; }
      const json = AnthropicService.#firstJsonObject(raw.text);
      if (!json) return null;
      const parsed = JSON.parse(json);
      const out = (Array.isArray(parsed.goals) ? parsed.goals : []).map(g => {
        const label = typeof g?.label === 'string' ? g.label.trim().slice(0, 60) : '';
        if (!label) return null;
        const ids = (Array.isArray(g.featureIndexes) ? g.featureIndexes : [])
          .map(i => picked[Number(i)]?.id).filter(Boolean);
        return { label, description: typeof g.description === 'string' ? g.description.trim().slice(0, 200) : '', achievableVia: [...new Set(ids)] };
      }).filter(Boolean);
      return out.length ? { goals: out } : null;
    } catch (e) { Logger.warn('AnthropicService', `synthesizeGoals error: ${e.message}`); return null; }
  }

  /**
   * v2.74.393 — Ground a user's raw intent in a specific page. Given the user's
   * intent + the page's affordance description, return a refined "grounded
   * intent" that restates the SAME goal in the page's concrete terms — WITHOUT
   * warping the goal toward what the page happens to offer — plus an
   * achievability verdict (the page may not serve the intent at all).
   * @returns {Promise<{groundedIntent:string, achievable:'yes'|'partial'|'no', note:string}|null>}
   */
  /**
   * SG-1 (Comprehend) — DESIGN_substrate_grounded_capabilities §4.1, §SG-1. The LLM's strongest fit:
   * turn the user's raw intent into a structured, PAGE-INDEPENDENT IntentSpec WITHOUT seeing any page.
   * No Locale/affordances/goals in the prompt — the spec must hold for whatever page serves the intent.
   * Returns the full IntentSpec (via Core/intentSpec.buildIntentSpec, which validates/clamps); on LLM or
   * parse failure it returns the lexical-fallback spec so callers always get a well-formed object. The
   * raw comprehension object is LOGGED. groundIntent (below) remains the separate, page-DEPENDENT
   * assessor; SG-2 Select folds them together.
   * @param {{userIntent:string}} args
   * @returns {Promise<object|null>} IntentSpec, or null for empty input.
   */
  static async comprehendIntent({ userIntent }) {
    const intent = (typeof userIntent === 'string' ? userIntent : '').trim();
    if (!intent) return null;
    const systemPrompt = `You COMPREHEND a user's web-automation intent into a structured, PAGE-INDEPENDENT plan. You are NOT shown any web page — your output must hold for WHATEVER page ends up serving the intent. Decompose the intent; do not solve it against a specific UI.

Return ONLY a JSON object:
{
  "shape": "read" | "act" | "complete" | "navigate",
  "target": "<the object the intent acts on>",
  "constraints": { },                  // values/filters STATED IN the intent (e.g. "cheapest" -> {"rank":"min-price"}; a named position/product/amount). {} if none.
  "dataNeeded": [ ],                   // values the intent does NOT contain but fulfilling it requires (e.g. for "apply for a job": full name, email, resume). [] if none.
  "subGoals": [ { "id": "<slug>", "label": "<phase>", "shape": "read|act|complete|navigate", "scope": "required" | "optional", "dependsOn": [ "<earlier id>" ], "successCondition": [ { "signal": "url" | "text" | "element" | "value", "match": "<generic observable proving THIS phase done>" } ] } ],
  "successCondition": [ { "signal": "url" | "text" | "element" | "value", "match": "<generic observable that proves it's done>" } ],
  "safety": "benign" | "consequential" | "irreversible"
}
Rules:
- "shape" = the PRIMARY operation; ignore hypothetical/subordinate mentions. read = find/view/extract/compare/understand content. act = ONE discrete action (click/toggle/sign in/like/download). complete = fill/submit a multi-field form (apply, register, check out, book, update details). navigate = go to / reach a place (open the pricing page, go to settings).
- "subGoals" = the ORDERED phases to accomplish the intent, PAGE-INDEPENDENT (generic phases, NOT specific field names). e.g. "apply for a job" -> [provide identity, provide contact details, provide location, attach resume, answer screening questions, submit]. A single-action intent has ONE subGoal. Use "dependsOn" to order them (the commit/submit depends on the data-entry phases). Mark a phase "optional" only if the intent can still succeed without it. Each phase MAY carry its own "successCondition" — the observable that proves THAT phase completed (e.g. a search phase: results list visible / url has the query). Phrase it generically (no specific page); prefer url/text observables. [] if none.
- "successCondition" = OBSERVABLE signals that PROVE completion, phrased generically (no specific page): a URL change ("confirmation"/"thank-you"), confirming text ("submitted"/"success"), an element appearing, or a value being set. This is exactly what a trial checks — never vague prose.
- "constraints" hold ONLY what the intent SAYS; "dataNeeded" names what it does NOT say but fulfilling requires. Do NOT invent values.
- "safety": benign = read/navigate/reversible. consequential = submits or changes data but reversible. irreversible = purchase, payment, delete, send, or otherwise permanent.`;
    const userText = `User intent: ${intent}`;
    Logger.info('AnthropicService', `comprehendIntent — "${intent.slice(0, 80)}"`);
    try {
      // v2.74.640 — 4096, not 1024: a multi-phase intent ("search + filter by pay, distance, job type,
      // experience, date") emits 6+ subGoals, each now carrying its own successCondition (SG-T2-5). At 1024
      // the JSON TRUNCATED mid-output → parse failed → null → empty lexical spec → 0 phases. (Re-comprehend
      // determinism / caching the propose-time spec is the deeper fix — audit C3 — but the cap is the bug.)
      const raw = await AnthropicService.#call(systemPrompt, [{ type: 'text', text: userText }], 4096, [], { role: 'describe', operation: 'comprehendIntent' });
      if (!raw?.success) { Logger.warn('AnthropicService', `comprehendIntent failed: ${raw?.error} — lexical fallback`); return buildIntentSpec(intent, null); }
      const json = AnthropicService.#firstJsonObject(raw.text);
      let comprehension = null;
      try { comprehension = json ? JSON.parse(json) : null; } catch (e) { comprehension = null; Logger.warn('AnthropicService', `comprehendIntent JSON parse failed (${e.message}) — likely truncated; lexical fallback`); }
      Logger.info('AnthropicService', `comprehendIntent comprehension: ${JSON.stringify(comprehension).slice(0, 1200)}`);
      const spec = buildIntentSpec(intent, comprehension);
      Logger.info('AnthropicService', `comprehendIntent spec: shape=${spec.shape} subGoals=${spec.subGoals.length} safety=${spec.safety} decidedBy=${spec.decidedBy}`);
      return spec;
    } catch (e) {
      Logger.warn('AnthropicService', `comprehendIntent error: ${e.message} — lexical fallback`);
      return buildIntentSpec(intent, null);
    }
  }

  /**
   * T3X — COMPREHEND a CROSS-GROUND (cross-site) intent into ORDERED SUB-INTENTS, each a whole task on ONE site.
   * The T3 analog of comprehendIntent ("intents all the way down"), one tier up: comprehendIntent splits an intent
   * into within-task PHASES; this splits a cross-SITE journey into SUB-INTENTS (each a saved-Strategy-sized task),
   * with `dependsOn` ordering and `stated` values (what the ask gives for that sub-intent → literal step params).
   * Given the user's known sites so it can phrase sub-intents around real Grounds. Returns null on failure (the
   * caller falls back to comprehendIntent). PAGE-INDEPENDENT; the matcher binds each sub-intent to a Strategy.
   * @param {{ ask:string, grounds?:{groundId:string,name:string}[] }} opts
   * @returns {Promise<{subIntents:{id:string,clause:string,dependsOn:string[],stated:object}[]}|null>}
   */
  static async comprehendCrossGround({ ask, grounds = [] }) {
    const intent = (typeof ask === 'string' ? ask : '').trim();
    if (!intent) return null;
    const siteList = (Array.isArray(grounds) ? grounds : []).map((g) => `- ${(g && (g.name || g.groundId)) || ''}`).filter((s) => s.length > 2).join('\n') || '(none known yet)';
    const systemPrompt = `You COMPREHEND a CROSS-SITE web-automation intent into ORDERED SUB-INTENTS, each a whole task performed on ONE site. You are NOT shown any page. Split the journey by SITE / task boundary — NOT into within-task field-by-field phases. e.g. "find a job on LinkedIn and save it to Notion" -> [ {find a job on LinkedIn}, {save it to Notion} ]. A single-site intent yields ONE sub-intent.

DATA HAND-OFF READ (the one exception to "don't split within a site"): when the user READS / EXTRACTS a value — get / grab / copy / take / retrieve the title, price, link, email, first result, … — and a LATER sub-intent USES that value, the read is ALWAYS its OWN sub-intent, EVEN on the same site as the step before it, because it PRODUCES the data the hand-off carries. NEVER fold "…and get the X" into the preceding action. The consuming sub-intent lists the read's id in dependsOn.
e.g. "search jazz singer jobs on Indeed, get the top title, and look it up on Pixabay" -> [ {search jazz singer jobs on Indeed}, {get the top job title} dependsOn the search, {look that title up on Pixabay} dependsOn the read ]  (THREE sub-intents — the read is NOT merged into the Indeed search).

ONE READ PER DISTINCT VALUE: if the user reads SEVERAL distinct values in one breath — "get the title, company, AND link" / "note its name and price" — emit a SEPARATE read sub-intent for EACH value (one output apiece), each dependsOn the same producer. Each is its own extraction that binds its own read capability and may feed a different consumer; NO single capability reads them all, so a merged "read the title, company, and link" clause matches nothing cleanly (it is a borderline partial match that binds unreliably). Do NOT merge distinct reads.
e.g. "get the top job's title, company, and link" -> [ {get the top job's title} dependsOn the search, {get the top job's company} dependsOn the search, {get the top job's link} dependsOn the search ]  (THREE reads, NOT one "title, company, and link" clause).

The user's known sites:
${siteList}

Return ONLY a JSON object:
{
  "subIntents": [
    { "id": "<slug>", "clause": "<the sub-intent, self-contained, naming its site when the ask does>",
      "dependsOn": [ "<earlier id whose RESULT this one needs>" ],
      "stated": { "<paramHint>": "<value the ASK gives for this sub-intent>" } }
  ]
}
Rules:
- Each sub-intent is ONE task on ONE site (search, save, post, buy, …) — the unit a saved Strategy performs — WITH the data-hand-off read exception above (a producing read is its own sub-intent).
- "dependsOn": list an earlier sub-intent ONLY when this one consumes its RESULT (e.g. "save the JOB you found" / "search Pixabay for the TITLE you read" depends on the find/read). This both orders execution AND wires the data hand-off.
- "stated": values the ASK explicitly provides for THIS sub-intent, keyed by a guessable param name (e.g. "find senior SWE jobs" -> {"keyword":"senior software engineer"}). For a sub-intent whose input COMES FROM an upstream read (it dependsOn it), leave that input OUT of stated — it's filled at run time from the read, NOT a literal. {} if the ask states none — do NOT invent.
- Phrase each clause so it stands alone and NAMES ITS SITE when the user did (the consumer of a read still names its own site, e.g. "…on Pixabay"). Keep the ORIGINAL order of mention.`;
    Logger.info('AnthropicService', `comprehendCrossGround — "${intent.slice(0, 80)}" (${(grounds || []).length} known sites)`);
    try {
      const raw = await AnthropicService.#call(systemPrompt, [{ type: 'text', text: `Cross-site intent: ${intent}` }], 2048, [], { role: 'describe', operation: 'comprehendCrossGround' });
      if (!raw?.success) { Logger.warn('AnthropicService', `comprehendCrossGround failed: ${raw?.error}`); return null; }
      const json = AnthropicService.#firstJsonObject(raw.text);
      let out = null;
      try { out = json ? JSON.parse(json) : null; } catch (e) { Logger.warn('AnthropicService', `comprehendCrossGround JSON parse failed (${e.message})`); return null; }
      if (!out || !Array.isArray(out.subIntents) || !out.subIntents.length) return null;
      out.subIntents = out.subIntents.map((s, i) => ({
        id: (s && s.id) || `s${i}`,
        clause: (s && (s.clause || s.label)) || intent,
        dependsOn: Array.isArray(s && s.dependsOn) ? s.dependsOn : [],
        stated: (s && s.stated && typeof s.stated === 'object') ? s.stated : {},
      }));
      Logger.info('AnthropicService', `comprehendCrossGround → ${out.subIntents.length} sub-intent(s): ${out.subIntents.map((s) => s.clause.slice(0, 40)).join(' | ')}`);
      return out;
    } catch (e) {
      Logger.warn('AnthropicService', `comprehendCrossGround error: ${e.message}`);
      return null;
    }
  }

  /**
   * Q2 — RESOLVE which Ground an ABSTRACT sub-intent runs on, by CLOSED-SET selection over the user's sites.
   * The LLM escalation for the ground resolver: when the lexical floor (groundCatalog.resolveGround) is a MISS or
   * AMBIGUOUS — e.g. "save this for later" names no site — the handler asks here for the best site by MEANING, not
   * lexical overlap. The model MUST pick one of the given groundIds or null; the caller re-validates with
   * pickValidGround (closed-set; never invents). This is the cross-Ground analog of the within-Ground matcher
   * snapping an LLM option to the page's real vocabulary. Returns { groundId|null } or null on any failure.
   * @param {{ clause:string, grounds?:{groundId:string,name:string,description?:string}[] }} opts
   * @returns {Promise<{groundId:(string|null)}|null>}
   */
  static async matchGround({ clause, grounds = [] }) {
    const ask = (typeof clause === 'string' ? clause : '').trim();
    const list = (Array.isArray(grounds) ? grounds : []).filter((g) => g && g.groundId);
    if (!ask || !list.length) return null;
    if (!(await AnthropicService.hasLlm())) return null;
    const siteLines = list.map((g) => `- ${g.groundId} — ${g.name || g.groundId}${g.description ? `: ${String(g.description).slice(0, 120)}` : ''}`).join('\n');
    const systemPrompt = `You choose which SITE a single web-automation sub-intent should run on. You are shown the user's known sites (id — name: what it's for). If the sub-intent NAMES a site, pick THAT one. Otherwise pick the ONE site whose purpose best fits by MEANING (e.g. "save this for later" -> a notes/bookmark site).

The user's sites:
${siteLines}

Return ONLY a JSON object: {"groundId":"<one id from the list, EXACTLY as written, or null if none fits>"}
Rules:
- groundId MUST be copied verbatim from the list above, or null. NEVER invent an id or a site.
- NAMED SITE WINS: if the sub-intent explicitly names a site ("…on Pixabay", "search Pixabay …", "save it to Notion"), pick THAT site — the named site is AUTHORITATIVE, even when the DATA it carries (a job title, a price, an email) sounds like another site's domain. e.g. "search for the job title on Pixabay" -> the Pixabay site (NOT a job board, despite the words "job title").
- Only when NO site is named: choose by what each site is FOR, not by shared words.
- Choose null when no listed site plausibly performs the sub-intent — do not force a poor fit.`;
    Logger.info('AnthropicService', `matchGround — "${ask.slice(0, 60)}" over ${list.length} site(s)`);
    try {
      const raw = await AnthropicService.#call(systemPrompt, [{ type: 'text', text: `Sub-intent: ${ask}` }], 64, [], { role: 'describe', operation: 'matchGround' });
      if (!raw?.success) { Logger.warn('AnthropicService', `matchGround failed: ${raw?.error}`); return null; }
      const json = AnthropicService.#firstJsonObject(raw.text);
      let out = null;
      try { out = json ? JSON.parse(json) : null; } catch (e) { Logger.warn('AnthropicService', `matchGround JSON parse failed (${e.message})`); return null; }
      if (!out) return null;
      const gid = out.groundId == null ? null : String(out.groundId).trim();
      Logger.info('AnthropicService', `matchGround → ${gid || 'null'}`);
      return { groundId: gid && gid !== 'null' ? gid : null };
    } catch (e) {
      Logger.warn('AnthropicService', `matchGround error: ${e.message}`);
      return null;
    }
  }

  /**
   * T3X — BIND the input VALUES a cross-Ground sub-intent's clause explicitly states to the bound capability's REAL
   * (UI-derived) param NAMES. The cross-Ground binder PICKS the capability but doesn't extract what to TYPE; without
   * this the search box runs EMPTY (every param stays a Workflow input). e.g. "search for game developer jobs on
   * Indeed" + ["SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY","EDIT_LOCATION"] -> {"SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY":
   * "game developer jobs"} (location omitted — the clause states none). Keys are EXACT param names so
   * wireCrossGroundData lowers them straight to step LITERALS. Returns { values:{} } or null on any failure
   * (the caller falls back to the comprehender's `stated`).
   * @param {{ clause:string, params?:(string|{name:string})[] }} opts
   * @returns {Promise<{values:object}|null>}
   */
  static async bindClauseParams({ clause, params = [] }) {
    const ask = (typeof clause === 'string' ? clause : '').trim();
    const names = (Array.isArray(params) ? params : []).map((p) => (typeof p === 'string' ? p : (p && p.name))).filter(Boolean);
    if (!ask || !names.length) return null;
    if (!(await AnthropicService.hasLlm())) return null;
    const systemPrompt = `You extract the input VALUES a one-line request explicitly provides, for a saved web capability whose input parameter NAMES are given (UI-derived, e.g. SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY).

Parameters:
${names.map((n) => `- ${n}`).join('\n')}

Return ONLY a JSON object: {"values": {"<EXACT_PARAM_NAME>": "<value from the request>"}}
Rules:
- Use the EXACT parameter name as the key, copied verbatim from the list above.
- Include a param ONLY when the request explicitly states a value for it. OMIT any param the request does not specify — never invent a location, date, category, etc.
- Strip the leading verb and the site name: "search for game developer jobs on Indeed" → the keyword/search param gets "game developer jobs" (not "search for…" and not "…on Indeed").
- A PRONOUN / back-reference is NOT a stated value — OMIT it: if the value would be "it", "that", "them", "this", "the one", "the first result", or "the title/price/link you found/read", the input comes from an EARLIER step's result, not this request (it's filled at run time, not typed).
- {} if the request states nothing bindable.`;
    Logger.info('AnthropicService', `bindClauseParams — "${ask.slice(0, 60)}" over ${names.length} param(s)`);
    try {
      const raw = await AnthropicService.#call(systemPrompt, [{ type: 'text', text: `Request: ${ask}` }], 256, [], { role: 'describe', operation: 'bindClauseParams' });
      if (!raw?.success) { Logger.warn('AnthropicService', `bindClauseParams failed: ${raw?.error}`); return null; }
      const json = AnthropicService.#firstJsonObject(raw.text);
      let out = null;
      try { out = json ? JSON.parse(json) : null; } catch (e) { Logger.warn('AnthropicService', `bindClauseParams JSON parse failed (${e.message})`); return null; }
      const vals = (out && out.values && typeof out.values === 'object') ? out.values : {};
      // Keep ONLY exact-name keys with non-empty string values (the model is told to copy names verbatim).
      const nameSet = new Set(names);
      const values = {};
      for (const [k, v] of Object.entries(vals)) { if (nameSet.has(k) && v != null && String(v).trim() !== '') values[k] = String(v); }
      Logger.info('AnthropicService', `bindClauseParams → ${Object.keys(values).length} value(s): ${Object.keys(values).join(', ') || '(none)'}`);
      return { values };
    } catch (e) {
      Logger.warn('AnthropicService', `bindClauseParams error: ${e.message}`);
      return null;
    }
  }

  /**
   * OBS-4 — NAME a recorded DEMONSTRATION (Path 3; the inverse of comprehendIntent). Given the actions the
   * user performed (kinds + element names + values, no page), return a short capability NAME + a one-line
   * INTENT. Post-hoc labelling of ground-truth actions. Returns { name, intent } or null on ANY failure —
   * the caller falls back to a heuristic name, so the feature never blocks on the LLM.
   * @param {{summary:string}} args  summary = a compact, per-fragment rendering of the trace
   */
  static async describeTrace({ summary, structure } = {}) {
    // ORCH-D — describe FROM the capability's STRUCTURE (phases of step-kinds + params with example values +
    // option vocabularies) when available, so the description is a faithful projection, not a loose transcript
    // guess. Falls back to a plain `summary` string for older callers. Also yields seed `aliases`.
    let text = '';
    if (structure && Array.isArray(structure.phases)) {
      const ph = structure.phases.map((p) => `Phase ${p.phase} (${p.label}): ${(Array.isArray(p.steps) ? p.steps : []).join('; ')}`).join('\n');
      const ps = (Array.isArray(structure.params) ? structure.params : []).map((p) => `- ${p.label} [${p.kind}]${Array.isArray(p.options) ? ` options: ${p.options.slice(0, 8).join(', ')}` : ''} (example: ${p.example})`).join('\n');
      text = `PHASES:\n${ph}${ps ? `\nINPUTS:\n${ps}` : ''}`;
    } else if (typeof summary === 'string') {
      text = summary;
    }
    text = text.trim();
    if (!text) return null;
    if (!(await AnthropicService.hasLlm())) return null;
    const systemPrompt = `You describe a recorded web-automation capability from its STRUCTURE (phases of steps + the inputs it takes). No page is shown. Return ONLY a JSON object:
{"name":"<=6 words, imperative — what it DOES>","intent":"<one sentence: what the capability is FOR>","aliases":["<2-5 short phrasings a user might type to ask for it>"]}
Rules:
- Describe what is ACCOMPLISHED, not each click. e.g. fill a search box + click Search + open a "Date posted" filter + choose an option -> name "Search jobs, filter by date".
- The name is a short imperative label for a RE-RUNNABLE capability. No trailing punctuation.
- Example input values are EXAMPLES — never bake them into name/intent/aliases (no "support"/"minneapolis"/"Last 3 days").
- aliases are natural ways to ASK for this — short, lowercase, no values (e.g. "search jobs", "find roles", "filter by date").`;
    try {
      const raw = await AnthropicService.#call(systemPrompt, [{ type: 'text', text }], 320, [], { role: 'describe', operation: 'describeTrace' });
      if (!raw?.success) { Logger.warn('AnthropicService', `describeTrace failed: ${raw?.error}`); return null; }
      const json = AnthropicService.#firstJsonObject(raw.text);
      const out = json ? JSON.parse(json) : null;
      if (!out || !out.name) return null;
      const aliases = Array.isArray(out.aliases) ? out.aliases.map((a) => String(a).toLowerCase().trim()).filter(Boolean).slice(0, 6) : [];
      Logger.info('AnthropicService', `describeTrace -> "${String(out.name).slice(0, 60)}" (${aliases.length} alias)`);
      return { name: String(out.name).slice(0, 80), intent: String(out.intent || out.name).slice(0, 200), aliases };
    } catch (e) { Logger.warn('AnthropicService', `describeTrace error: ${e.message}`); return null; }
  }

  /**
   * ORCH-M — the smart HIT/MISS scorer. ONE call over the SCOPED, runnable-here candidates (the grounded funnel
   * already filtered by Ground/Locale + executability, so the choice set is small and every option is real —
   * the only regime where LLM matching is trustworthy). For EACH candidate it judges effect-eligibility +
   * relevance; for its single best pick it BINDS the ask's values to the params (option params chosen from the
   * given vocabulary, never invented). Returns raw ratings + bindings; Core/orchMatch.scoresToScorer feeds the
   * deterministic gate and validateBindings enforces the vocabulary. Conservative by construction (precision-
   * first). Returns null on no-LLM / failure so the caller falls back to the lexical scorer.
   * @param {{ask:string, context?:string, candidates:object[]}} args  candidates = projected Candidates (here-set)
   * @returns {Promise<{scores:object[], topId:(string|null), bindings:object, rationale:string}|null>}
   */
  static async matchCapability({ ask, context = '', candidates = [], affordances = [], examples = null } = {}) {
    const list = Array.isArray(candidates) ? candidates : [];
    if (!ask || typeof ask !== 'string' || !ask.trim() || !list.length) return null;
    if (!(await AnthropicService.hasLlm())) return null;
    const conf = (examples && examples.confirmed) || {};
    const rej = (examples && examples.rejected) || {};
    const lean = list.map((c) => ({
      id: c.id, intent: c.intent || '', aliases: (c.aliases || []).slice(0, 8),
      params: (Array.isArray(c.params) ? c.params : []).filter((p) => p && p.used).map((p) => ({
        name: p.name, kind: p.kind, ...(Array.isArray(p.vocabulary) ? { options: p.vocabulary.slice(0, 12) } : {}),
      })),
      // ORCH-FB-2 (option 1) — past corrections for THIS capability, so the model generalizes from them.
      ...(Array.isArray(conf[c.id]) && conf[c.id].length ? { confirmedAsks: conf[c.id].slice(0, 5) } : {}),
      ...(Array.isArray(rej[c.id]) && rej[c.id].length ? { rejectedAsks: rej[c.id].slice(0, 5) } : {}),
    }));
    const aff = (Array.isArray(affordances) ? affordances : []).slice(0, 60);
    const systemPrompt = `You match a user's ASK to grounded capabilities on the current page. Each CANDIDATE is already runnable here. For EACH candidate, judge whether its effect plausibly ACHIEVES the ask (effectEligible) and its relevance (0..1). Then for your single best candidate, BIND the ask's values to its params. For an "option" param, the value SHOULD be one of that param's given options — but if the ask names a DIFFERENT option that appears in PAGE_AFFORDANCES (the controls the page actually has), you MAY bind that instead (the page confirms it exists). e.g. a "search by category" capability demonstrated for "Vectors" can be re-bound to "Illustrations" when Illustrations is in PAGE_AFFORDANCES. Other params take a value extracted from the ask. A candidate may carry confirmedAsks (asks the USER previously CONFIRMED this capability handles — strong evidence it fits SIMILAR asks) and rejectedAsks (asks the user previously said this capability is WRONG for — strong evidence to rate it LOW for similar asks). Weight these corrections heavily. Be CONSERVATIVE — rate relevance high only when the capability clearly does what's asked; never invent an option the page doesn't have. Return ONLY JSON:
{"scores":[{"id":"<id>","relevance":<0..1>,"effectEligible":<true|false>}],"topId":"<best id or null>","bindings":{"<PARAM>":"<value>"},"rationale":"<one short sentence>"}`;
    const user = `ASK: ${ask}\n${context ? `CONTEXT: ${String(context).slice(0, 400)}\n` : ''}${aff.length ? `PAGE_AFFORDANCES: ${JSON.stringify(aff)}\n` : ''}CANDIDATES:\n${JSON.stringify(lean)}`;
    try {
      // 1500 output tokens — a 10-candidate scores[] + bindings can exceed 512 and truncate → JSON parse fail.
      const raw = await AnthropicService.#call(systemPrompt, [{ type: 'text', text: user }], 1500, [], { role: 'match', operation: 'matchCapability' });
      if (!raw?.success) { Logger.warn('AnthropicService', `matchCapability — LLM call FAILED: ${raw?.error}`); return null; }
      const json = AnthropicService.#firstJsonObject(raw.text);
      if (!json) { Logger.warn('AnthropicService', `matchCapability — no JSON in response: "${String(raw.text).slice(0, 240)}"`); return null; }
      let out;
      try { out = JSON.parse(json); }
      catch (pe) { Logger.warn('AnthropicService', `matchCapability — JSON parse FAILED (${pe.message}): "${String(json).slice(0, 240)}"`); return null; }
      if (!out) return null;
      const scores = Array.isArray(out.scores) ? out.scores.filter((s) => s && s.id != null) : [];
      Logger.info('AnthropicService', `matchCapability -> top ${out.topId || '(none)'} over ${list.length} candidate(s), ${scores.length} scored`);
      return {
        scores, topId: out.topId != null ? String(out.topId) : null,
        bindings: (out.bindings && typeof out.bindings === 'object') ? out.bindings : {},
        rationale: String(out.rationale || '').slice(0, 200),
      };
    } catch (e) { Logger.warn('AnthropicService', `matchCapability — EXCEPTION: ${e.message}`); return null; }
  }

  /**
   * ORCH-FB — the LLM WRAPPER for free-text corrective feedback. Maps the user's correction about the LAST action
   * into a structured corrective intent the chat applies via ORCH_FEEDBACK. Beyond the lexical floor
   * (Core/orchFeedback.classifyFeedback): it disambiguates "wrong category, should be Vectors" → wrong_value with
   * {CATEGORY:'Vectors'}. Returns null on no-LLM / parse failure (caller falls back to the lexical kind).
   * @param {{text:string, context:object}} args  context = { intent, ask, bindings, params }
   * @returns {Promise<{kind:string, correction:(object|null), confidence:number}|null>}
   */
  static async interpretFeedback({ text, context = {} } = {}) {
    if (!text || typeof text !== 'string' || !text.trim()) return null;
    if (!(await AnthropicService.hasLlm())) return null;
    const KINDS = ['reject_match', 'reject_run', 'wrong_value', 'retract', 'undo', 'affirm', 'none'];
    const lean = {
      intent: context.intent || '', ask: context.ask || '',
      bindings: (context.bindings && typeof context.bindings === 'object') ? context.bindings : {},
      params: (Array.isArray(context.params) ? context.params : []).filter((p) => p && p.used).map((p) => ({ name: p.name, kind: p.kind, ...(Array.isArray(p.vocabulary) ? { options: p.vocabulary.slice(0, 12) } : {}) })),
    };
    const systemPrompt = `You interpret a user's CORRECTIVE FEEDBACK about an automated action just taken in a browser-automation chat. Classify it into ONE corrective intent; if they gave a corrected value, extract it.
KINDS: reject_match (wrong capability chosen) · reject_run (it ran but did the wrong thing) · wrong_value (RIGHT capability, WRONG parameter value — extract the corrected value) · retract (the capability is broken — delete it) · undo (revert) · affirm (it was correct) · none (not actually feedback).
For wrong_value, map the corrected value to one of LAST_ACTION.params by name (use its options when given). Otherwise correction is null.
Reply ONLY with JSON: {"kind":"<one of ${KINDS.join('|')}>","correction":{"<PARAM>":"<value>"}|null,"confidence":<0..1>}`;
    const user = `FEEDBACK: ${text}\nLAST_ACTION: ${JSON.stringify(lean)}`;
    try {
      const raw = await AnthropicService.#call(systemPrompt, [{ type: 'text', text: user }], 256, [], { role: 'match', operation: 'interpretFeedback' });
      if (!raw?.success) { Logger.warn('AnthropicService', `interpretFeedback — LLM call FAILED: ${raw?.error}`); return null; }
      const json = AnthropicService.#firstJsonObject(raw.text);
      if (!json) return null;
      let out; try { out = JSON.parse(json); } catch { return null; }
      if (!out || !KINDS.includes(out.kind)) return null;
      Logger.info('AnthropicService', `interpretFeedback -> ${out.kind}${out.correction ? ` ${JSON.stringify(out.correction)}` : ''}`);
      return { kind: out.kind, correction: (out.correction && typeof out.correction === 'object') ? out.correction : null, confidence: Number(out.confidence) || 0.6 };
    } catch (e) { Logger.warn('AnthropicService', `interpretFeedback — EXCEPTION: ${e.message}`); return null; }
  }

  /**
   * ORCH-X compiler front-end — SEMANTICALLY decompose a complex ASK into an ORDERED plan over the user's recorded
   * CAPABILITIES, binding each step's params from the ask. This is what the lexical decomposeAsk can't do: turn
   * "search SWE jobs in minneapolis posted last 7 days" into [Search jobs {title, location} → Filter by date
   * {when}]. Most asks are ONE step (caller falls back to the single matcher then). Returns null on no-LLM/parse fail.
   * @param {{ask:string, candidates:object[], affordances:string[]}} args
   * @returns {Promise<{steps:Array<{id:string,bindings:object,clause:string}>, rationale:string}|null>}
   */
  static async planAskOverCapabilities({ ask, candidates = [], affordances = [] } = {}) {
    const list = Array.isArray(candidates) ? candidates : [];
    if (!ask || typeof ask !== 'string' || !ask.trim() || !list.length) return null;
    if (!(await AnthropicService.hasLlm())) return null;
    const lean = list.map((c) => ({
      id: c.id, intent: c.intent || '', kind: (c.kind === 'observation' ? 'observation' : 'action'),
      params: (Array.isArray(c.params) ? c.params : []).filter((p) => p && p.used).map((p) => ({ name: p.name, kind: p.kind, ...(Array.isArray(p.vocabulary) ? { options: p.vocabulary.slice(0, 12) } : {}) })),
    }));
    const aff = (Array.isArray(affordances) ? affordances : []).slice(0, 60);
    const systemPrompt = `Decompose the ASK into an ORDERED sequence of STEPS, each accomplished by exactly ONE of the CANDIDATES (the user's recorded capabilities). MOST asks are ONE step; a COMPLEX ask spans several — e.g. "search SWE jobs in minneapolis posted last 7 days" = a SEARCH step (title+location) THEN a FILTER-by-date step. ORDER matters: a step that operates on results comes AFTER the step that produces them (search before filter/sort). Each CANDIDATE has a "kind": 'observation' = a READ that REPORTS page state without changing it; 'action' = changes the page.
CONDITIONALS: when part of the ASK is "if/when/unless <condition>, <action>" (or "<action> if/unless <condition>"), the <condition> TESTS current page state — cover it with an OBSERVATION candidate (kind:'observation') that reads the thing being tested, placed IMMEDIATELY BEFORE the <action> step(s) it gates. The condition READS what is already on the page — do NOT INVENT a search/navigate step JUST to satisfy the condition. BUT if the ASK ALSO explicitly requests an action (e.g. "search for jobs AND if there are any jobs, sort by date"), KEEP that action as its OWN step BEFORE the condition — it is a real step, not the condition; never drop it to "uncovered". PREFER an observation over a same-named action for the condition ITSELF: "if there are any JOBS, sort by date" → a jobs-LIST observation, not a "search jobs" action. If no observation candidate can read the condition, list the condition in "uncovered". So "search for jobs and if there are any jobs, sort by date" = [search ACTION, jobs-list OBSERVATION, sort ACTION] in that order.
Bind each step's params from the ask: an "option" param's value SHOULD be one of that param's options, or a label in PAGE_AFFORDANCES; other params take a value extracted from the ask. Use ONLY real candidate ids. If a part of the ASK has NO matching candidate — a constraint/filter the user clearly wants but no capability performs (e.g. "remote", "salary over $90000", "sorted by newest") — do NOT force a wrong step; instead list it in "uncovered" as a short imperative phrase ("filter by remote", "filter by salary over $90000"). Be conservative — don't invent steps. Return ONLY JSON:
{"steps":[{"id":"<candidate id>","bindings":{"<PARAM>":"<value>"},"clause":"<the part of the ask this step covers>"}],"uncovered":["<a constraint no candidate covers>"],"rationale":"<one short sentence>"}`;
    const user = `ASK: ${ask}\n${aff.length ? `PAGE_AFFORDANCES: ${JSON.stringify(aff)}\n` : ''}CANDIDATES:\n${JSON.stringify(lean)}`;
    try {
      const raw = await AnthropicService.#call(systemPrompt, [{ type: 'text', text: user }], 1500, [], { role: 'match', operation: 'planAskOverCapabilities' });
      if (!raw?.success) { Logger.warn('AnthropicService', `planAskOverCapabilities — LLM call FAILED: ${raw?.error}`); return null; }
      const json = AnthropicService.#firstJsonObject(raw.text);
      if (!json) return null;
      let out; try { out = JSON.parse(json); } catch { return null; }
      const steps = (out && Array.isArray(out.steps) ? out.steps : []).filter((s) => s && s.id != null).map((s) => ({ id: String(s.id), bindings: (s.bindings && typeof s.bindings === 'object') ? s.bindings : {}, clause: String(s.clause || '').slice(0, 160) }));
      const uncovered = (out && Array.isArray(out.uncovered) ? out.uncovered : []).map((u) => String(u || '').slice(0, 80)).filter(Boolean).slice(0, 4);
      Logger.info('AnthropicService', `planAskOverCapabilities -> ${steps.length} step(s), ${uncovered.length} uncovered, over ${list.length} candidate(s)`);
      return { steps, uncovered, rationale: String(out.rationale || '').slice(0, 200) };
    } catch (e) { Logger.warn('AnthropicService', `planAskOverCapabilities — EXCEPTION: ${e.message}`); return null; }
  }

  /**
   * SG-2b (Select, the narrowed-LLM match) — DESIGN §4.2/§SG-2. Map each page-INDEPENDENT subGoal (from
   * SG-1 Comprehend) to the page's REAL features, by MEANING. The LLM's role is deliberately narrow: it
   * only proposes the semantic mapping over a pre-filtered candidate set; Core/select.reconcileMatches
   * then disposes of the facts (validates ids, reconciles scope vs the page's `required` flag, surfaces
   * orphan required features the prior missed). Returns the reconciled selection; on LLM/parse failure it
   * still returns a reconciled selection (empty matches → all required features become orphans — honest).
   * The raw mapping + a reconciliation summary are LOGGED.
   * @param {{spec:object, locale:object}} args  spec = IntentSpec; locale = the Locale (SG-0.5).
   */
  static async matchSubGoals({ spec, locale, conventions = null }) {
    const subGoals = (spec && Array.isArray(spec.subGoals)) ? spec.subGoals : [];
    const candidates = selectCandidates(locale, spec);
    if (!subGoals.length || !candidates.length) {
      Logger.info('AnthropicService', `matchSubGoals — nothing to match (${subGoals.length} subGoal(s), ${candidates.length} candidate(s)) → boundary-only`);
      return reconcileMatches(locale, spec, null);
    }
    // v2.74.621 (SG-RES-6) — prompt hardening. The sub-goals are NOT independent labels: Comprehend emits
    // them as one ORDERED, dependsOn-linked operation (a single proto-perspective), but the old prompt
    // matched them one at a time, dropped the dependsOn edges entirely, and explicitly rewarded abstaining
    // ([]) on the fuzzy ones — so "search for jobs" returned the submit and dropped the inputs, and the
    // trial clicked Search on an empty form. Fix: (1) render the dependsOn edges (below), (2) frame the
    // phases as ONE connected operation, (3) add the ATOMICITY invariant (a commit must carry the phases it
    // depends on, or be omitted), (4) stop biasing toward [] on REQUIRED phases. (Probabilistic floor-raise;
    // the structural cure is goal-grounded binding off achievableVia — this strengthens the LLM stage.)
    const systemPrompt = `You MATCH the sub-goals of a user's intent to the ACTUAL features of a specific page. You are given the intent's SUB-GOALS (generic, page-independent phases) and a list of the page's real FEATURES (each: id, label, kind, and whether it is required). For each sub-goal, choose the feature id(s) that accomplish it — by MEANING, not word overlap (e.g. "provide identity" → the first/last name inputs; "attach resume" → the file-upload control; "submit" → the submit action).

The sub-goals are NOT independent items to match one at a time — together they form ONE coherent operation. A sub-goal line may carry "depends on: <ids>", meaning it cannot succeed until those earlier phases are done (e.g. a submit depends on the data-entry phases that feed it). Bind the operation as a connected whole.

Rules:
- A feature serves AT MOST ONE sub-goal. A sub-goal may map to several features.
- Map ONLY to feature ids that appear in the list. NEVER invent an id.
- ATOMICITY: if you map a phase that COMMITS or SUBMITS (it lists "depends on", or its feature is marked [submit]), you MUST also map every phase it depends on. A plan that submits or searches a form WITHOUT first entering its data is INVALID and will fail — bind the whole dependency chain, or omit the commit phase entirely.
- It is correct to leave page features unclaimed (decoys, unrelated controls — don't force them in), and to leave an OPTIONAL sub-goal unmapped when the page truly has no feature for it. But do NOT abstain on a REQUIRED phase that a feature plausibly serves — under-binding a required data-entry phase silently breaks the operation. When unsure between a plausible feature and nothing for a required phase, prefer the plausible feature.

Return ONLY a JSON object:
{ "matches": { "<subGoalId>": ["<featureId>", ...] } }`;
    const sgBlock = subGoals.map((s) => {
      const deps = (Array.isArray(s.dependsOn) && s.dependsOn.length) ? `, depends on: ${s.dependsOn.join(', ')}` : '';
      return `- ${s.id}: ${s.label} (${s.shape}${s.scope ? `, ${s.scope}` : ''}${deps})`;
    }).join('\n');
    // Rank by relevance to the intent BEFORE the cap, so the target survives on a feature-dense page (a
    // nav-heavy site has 100+ candidates; an unranked slice can drop the very control the intent names).
    const ranked = rankCandidates(candidates, spec, { conventions });   // GA-5 — Ground's selector-tier history breaks ranking ties
    const featBlock = ranked.slice(0, 100).map((f) => `- ${f.id}: "${(f.label || '').slice(0, 60)}" [${f.kind}${f.fieldType ? `/${f.fieldType}` : ''}${f.required ? ', required' : ''}${f.interaction && f.interaction.effect === 'submit' ? ', submit' : ''}]`).join('\n');
    const userText = `Sub-goals:\n${sgBlock}\n\nPage features:\n${featBlock}`;
    Logger.info('AnthropicService', `matchSubGoals — ${subGoals.length} sub-goal(s) over ${candidates.length} feature(s)`);
    let rawMatches = null;
    try {
      const call = await AnthropicService.#call(systemPrompt, [{ type: 'text', text: userText }], 1024, [], { role: 'describe', operation: 'matchSubGoals' });
      if (call?.success) {
        const json = AnthropicService.#firstJsonObject(call.text);
        try { const p = json ? JSON.parse(json) : null; rawMatches = (p && typeof p.matches === 'object') ? p.matches : null; } catch { rawMatches = null; }
      } else { Logger.warn('AnthropicService', `matchSubGoals failed: ${call?.error}`); }
    } catch (e) { Logger.warn('AnthropicService', `matchSubGoals error: ${e.message}`); }
    Logger.info('AnthropicService', `matchSubGoals raw: ${JSON.stringify(rawMatches).slice(0, 1000)}`);
    const reconciled = reconcileMatches(locale, spec, rawMatches);
    const changed = reconciled.reconciledSubGoals.filter((s) => s.scopeChanged).length;
    Logger.info('AnthropicService', `matchSubGoals reconciled: matched=${Object.keys(reconciled.matches).length} orphanRequired=${reconciled.orphanRequired.length} scopeChanged=${changed}`);
    return reconciled;
  }

  static async groundIntent({ userIntent, affordances, goals = null, url, title }) {
    const intent = (typeof userIntent === 'string' ? userIntent : '').trim();
    if (!intent) return null;
    const goalList = (Array.isArray(goals) ? goals : []).filter(g => g && g.label);
    const hasGoals = goalList.length > 0;
    const systemPrompt = `You ASSESS a user's automation intent against a specific web page. You DO NOT rewrite or restate the intent — the user's own words are kept verbatim. Your only job is the structured assessment: can this page serve the intent, and what SHAPE of operation is it?
${hasGoals ? `
You are given the page's structured GOALS (the distinct outcomes it supports). MATCH the user's intent to the closest goal(s): set "matchedGoal" to the best-fitting goal's label (or "" if none fits), and base "achievable" on goal coverage (full match → yes; the intent spans a goal plus more the page lacks → partial; no goal fits → no).` : ''}
Return ONLY a JSON object:
{
  "achievable": "yes" | "partial" | "no",${hasGoals ? `\n  "matchedGoal": "<the label of the best-fitting page goal, or \\"\\" if none>",` : ''}
  "shape": "read" | "act" | "complete",
  "completeness": "exhaustive" | "minimal",
  "note": "<short: what this page covers / what it can't do for this intent>"
}
- "yes" = the page fully supports the intent. "partial" = some of it (note what's missing). "no" = this page can't serve the intent.
- "shape": classify the user's PRIMARY action — IGNORE subordinate or hypothetical mentions. "VIEW the job description before deciding whether to apply" is "read" (viewing is the action; applying is hypothetical), NOT "complete". "complete" = the user must fill in / submit a form or multi-field input (apply, register, check out, book, update details). "read" = find / view / extract / compare / understand content. "act" = a single discrete action (click, toggle, sign in, like, download).
- "completeness": for a "complete" intent, is EVERY required field needed, or only a focused subset? "exhaustive" = the whole form must be filled ("apply for this job", "fill out the application", "register an account"). "minimal" = a specific field/control or a single action ("update my phone number", "search for X", "sign in"). read/act intents are virtually always "minimal".`;
    let userText = `User intent: ${intent}\nURL: ${url ?? '(unknown)'}\nTitle: ${title ?? '(unknown)'}`;
    if (hasGoals) {
      const block = goalList.slice(0, 12).map(g => `- ${g.label}${g.description ? `: ${String(g.description).slice(0, 120)}` : ''}`).join('\n');
      userText += `\n\nPAGE GOALS (the outcomes this page supports — match the intent to one):\n${block}`;
    }
    if (affordances) userText += `\n\nPage summary:\n${String(affordances).slice(0, hasGoals ? 1200 : 3000)}`;
    if (!hasGoals && !affordances) userText += `\n\nPage affordances: (none provided)`;
    Logger.info('AnthropicService', `groundIntent — "${intent.slice(0, 60)}"${hasGoals ? ` (${goalList.length} goals)` : ''}`);
    try {
      const raw = await AnthropicService.#call(systemPrompt, [{ type: 'text', text: userText }], 500, [], { role: 'describe', operation: 'groundIntent' });
      if (!raw?.success) { Logger.warn('AnthropicService', `groundIntent failed: ${raw?.error}`); return null; }
      const json = AnthropicService.#firstJsonObject(raw.text);
      if (!json) return null;
      const p = JSON.parse(json);
      const ACH = new Set(['yes', 'partial', 'no']);
      const SHAPE = new Set(['read', 'act', 'complete']);
      const CMPL = new Set(['exhaustive', 'minimal']);
      // ASSESSMENT only — no prose rewrite. The user's own intent text is the saved artifact; this call
      // just classifies SHAPE/COMPLETENESS (drives the proposal directive) + judges achievability. The
      // LLM is a far better intent-understander than the lexical classifier ("view X before applying" →
      // read), and it's free (same call). deriveIntentSpec consumes shape/completeness; lexical is fallback.
      return {
        achievable: ACH.has(p.achievable) ? p.achievable : 'partial',
        note: typeof p.note === 'string' ? p.note.trim().slice(0, 240) : '',
        matchedGoal: typeof p.matchedGoal === 'string' && p.matchedGoal.trim() ? p.matchedGoal.trim().slice(0, 60) : null,
        shape: SHAPE.has(p.shape) ? p.shape : null,
        completeness: CMPL.has(p.completeness) ? p.completeness : null,
      };
    } catch (e) { Logger.warn('AnthropicService', `groundIntent error: ${e.message}`); return null; }
  }

  /**
   * v2.74.468 — LLM re-rank of the site capability catalog against a free-text intent. The pure
   * lexical matcher (SiteMap.matchSiteCapabilities) is the instant default + fallback; this adds
   * SEMANTIC matching ("buy" ≈ "checkout", "sign up" ≈ "create an account") the token-overlap
   * ranker can't see. Given the intent + the site's goals (NUMBERED), returns the best-fitting
   * goals ranked best-first as 1-based indices + a terse reason. [] when none fit; null on
   * failure (caller falls back to the lexical ranker). Pure-ish: no storage, just one LLM call.
   * @param {{intent:string, goals:Array<{label:string,pageTypes?:string[]}>}} args
   * @returns {Promise<Array<{i:number, why:string}> | null>}
   */
  static async matchCapabilitiesLLM({ intent, goals }) {
    const q = (typeof intent === 'string' ? intent : '').trim();
    const list = (Array.isArray(goals) ? goals : []).filter(g => g && g.label).slice(0, 60);
    if (!q || !list.length) return null;
    const systemPrompt = `You match a user's intent to the things a website lets you do. You are given the user's intent and a NUMBERED list of the site's capabilities (each a goal the site supports). Pick the capabilities that accomplish the intent, ranked best-first. INCLUDE semantic matches — synonyms and paraphrases (e.g. "buy" ≈ "checkout"/"purchase"; "sign up" ≈ "create an account"; "see prices" ≈ "view pricing") — not just literal word overlap. Exclude capabilities that don't actually serve the intent.

Return ONLY a JSON object:
{ "matches": [ { "i": <capability number>, "why": "<=8 words: how it serves the intent>" } ] }
Ranked best-first. Return { "matches": [] } if NOTHING on the site fits the intent. Never invent numbers outside the list.`;
    const block = list.map((g, idx) => `${idx + 1}. ${g.label}${g.pageTypes && g.pageTypes.length ? ` [${g.pageTypes.join('/')}]` : ''}`).join('\n');
    const userText = `User intent: ${q}\n\nSite capabilities:\n${block}`;
    Logger.info('AnthropicService', `matchCapabilitiesLLM — "${q.slice(0, 60)}" over ${list.length} goal(s)`);
    try {
      const raw = await AnthropicService.#call(systemPrompt, [{ type: 'text', text: userText }], 500, [], { role: 'describe', operation: 'matchCapabilities' });
      if (!raw?.success) { Logger.warn('AnthropicService', `matchCapabilitiesLLM failed: ${raw?.error}`); return null; }
      const json = AnthropicService.#firstJsonObject(raw.text);
      if (!json) return null;
      const p = JSON.parse(json);
      const matches = Array.isArray(p.matches) ? p.matches : [];
      const out = [];
      for (const m of matches) {
        const i = Number.isInteger(m && m.i) ? m.i : parseInt(m && m.i, 10);
        if (!(i >= 1 && i <= list.length)) continue;
        out.push({ i, why: (m && typeof m.why === 'string') ? m.why.trim().slice(0, 80) : '' });
      }
      return out;
    } catch (e) { Logger.warn('AnthropicService', `matchCapabilitiesLLM error: ${e.message}`); return null; }
  }

  /**
   * v2.74.396 — Visual role locator (Resolve Tier-2 fallback / "Path C"). Given a
   * ROLE + the current viewport screenshot (+ intent / page-affordance context),
   * return a NORMALIZED bounding box (screenshot space, top-left origin) of the
   * element that PLAYS the role — mirroring how a person scanning the page finds
   * where to click. The caller hit-tests the box against real element rects (IoU)
   * to resolve the actual element, then runs the Pick→Claude refine. This is used
   * ONLY for roles the DOM-text resolve pass couldn't pin down (abstained / failed
   * verification), so the per-role vision cost is paid only on the hard cases.
   *
   * Returns null on parse failure; `{ found:false }` when the role isn't visible
   * in this screenshot (below the fold / not present) — do NOT guess a box then.
   * @returns {Promise<{found:boolean, box:{x1:number,y1:number,x2:number,y2:number}|null, confidence:number, note:string}|null>}
   */
  static async locateRoleRegion({ role, description, intent, affordances, url, title, screenshot }) {
    if (!role || typeof screenshot !== 'string') return null;
    const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(screenshot);
    if (!m) return null;
    const systemPrompt = `You visually locate the element that plays a named ROLE on a web page — the way a person scanning the page finds where to click. You are shown a screenshot of the CURRENT viewport and a role to find.

Return ONLY a JSON object:
{ "found": true, "box": { "x1": 0.0, "y1": 0.0, "x2": 1.0, "y2": 1.0 }, "confidence": 0.0, "note": "" }

COORDINATES: normalized [0.0,1.0] in SCREENSHOT space, top-left origin (x=0 left edge, x=1 right edge; y=0 TOP edge, y=1 BOTTOM edge). The box is TIGHT around the element that plays the role, with x1<x2 and y1<y2.
- CONTAINER / CONTENT role (card, tile, row, list item, section, gallery item): box the WHOLE repeating block — NOT an inner image or text label inside it.
- CONTROL role (button, input, link, tab, menu trigger): box just that control.

RULES:
- If the role's element is NOT visible in this screenshot (it is below the fold, scrolled off, or simply not on this page), return { "found": false, "box": null, "confidence": <0..1 how sure it's absent>, "note": "<why>" }. Do NOT invent a box for something you cannot see.
- If several candidates match, pick the most prominent / primary instance and box THAT one.
- "confidence" in [0,1]: how sure you are the box contains exactly the element that plays the role.
- Output ONLY the JSON object, no prose.`;
    let text = `Role to locate: ${role}\nRole description: ${(description ?? '').toString().trim() || '(none)'}\nPerspective intent: ${(intent ?? '').toString().trim() || '(none)'}\nURL: ${url ?? '(unknown)'}\nTitle: ${title ?? '(unknown)'}`;
    if (affordances) text += `\n\nPage affordances (what this kind of page supports):\n${String(affordances).slice(0, 1500)}`;
    text += `\n\nThe current viewport screenshot is attached. Return the normalized box of the element that plays the role "${role}", or found:false if it is not visible here.`;
    const userContent = [
      { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
      { type: 'text', text },
    ];
    Logger.info('AnthropicService', `locateRoleRegion — "${role}"`);
    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 400, [], { role: 'resolve', operation: 'locateRoleRegion' });
      if (!raw?.success) { Logger.warn('AnthropicService', `locateRoleRegion failed: ${raw?.error}`); return null; }
      const json = AnthropicService.#firstJsonObject(raw.text);
      if (!json) return null;
      const p = JSON.parse(json);
      const conf = typeof p?.confidence === 'number' ? p.confidence : 0.5;
      const note = typeof p?.note === 'string' ? p.note.trim().slice(0, 200) : '';
      if (!p || p.found !== true || !p.box) return { found: false, box: null, confidence: conf, note };
      const b = p.box;
      const nums = ['x1', 'y1', 'x2', 'y2'].map(k => Number(b[k]));
      if (nums.some(v => !Number.isFinite(v) || v < -0.05 || v > 1.05)) return null;
      const [x1, y1, x2, y2] = nums.map(v => Math.min(1, Math.max(0, v)));
      if (x2 <= x1 || y2 <= y1) return null;
      return { found: true, box: { x1, y1, x2, y2 }, confidence: conf, note };
    } catch (e) { Logger.warn('AnthropicService', `locateRoleRegion error: ${e.message}`); return null; }
  }

  /**
   * v2.74.352 — "Resolve roles": given a proposed perspective's ROLES and the
   * current page, return a concrete CSS selector for each role (or null to
   * abstain). The inverse of the picker — Claude resolves all roles in one
   * call; the caller verifies each selector against the live DOM and routes
   * abstentions/failures to manual picking. See DESIGN_resolve_roles.md.
   *
   * Context for accuracy: screenshot (visual prominence / repetition) + rich
   * DOM (real attributes) + the Ground's existing landmarks (reuse). The
   * system, not Claude, owns verification — so a wrong selector is caught, not
   * trusted.
   *
   * v2.74.356 — Optional `priorAttempt` turns this into a REPAIR pass (the
   * opt-in feedback loop, DESIGN_resolve_roles.md § 8): `{ confirmed:[{role,
   * selector}], attempts:[{role, selector, reason}] }`. Confirmed selectors are
   * shown as working-on-this-site guides (not re-emitted); each attempt's prior
   * selector + verification failure reason is fed back so Claude returns a
   * corrected selector. `roles` then contains only the unresolved roles.
   *
   * @param {{ roles: Array<{role:string,description?:string,multiplicity?:string}>, url?:string, title?:string, domSnapshot?:string, screenshot?:string|null, registryLandmarks?:Array|null, priorAttempt?:{confirmed?:Array,attempts?:Array}|null }} params
   * @returns {Promise<{ resolutions: Array<{role:string, selector:string|null, confidence:number, justification:string}> }|null>}
   */
  static async resolveRoles({ roles, url, title, domSnapshot, screenshot = null, registryLandmarks = null, priorAttempt = null, knownSelectors = null, conventions = null }) {
    const roleList = (Array.isArray(roles) ? roles : [])
      .filter(r => r && typeof r.role === 'string' && r.role.trim());
    if (roleList.length === 0) return null;

    const systemPrompt = `You resolve a set of named ROLES to concrete CSS selectors on the CURRENT page. You are given each role (name + description + multiplicity), the page (a screenshot, if attached, plus a sanitized DOM listing with real element attributes), and any landmarks already captured on this Ground. For each role return ONE CSS selector for the element that plays it — or null if no element on THIS page clearly matches.

Return ONLY a JSON object:
{
  "resolutions": [
    { "role": "search-input", "selector": "#search", "confidence": 0.9, "justification": "the labelled search textbox in the header" },
    { "role": "result-item",  "selector": "ul.results > li", "confidence": 0.8, "justification": "repeating result rows" },
    { "role": "promo-banner", "selector": null, "confidence": 0.0, "justification": "no matching element on this page" }
  ]
}

Rules:
- Selector MUST be pure CSS usable by document.querySelectorAll. NEVER use Playwright/Cypress/jQuery extensions (:has-text, :text, :text-is, :contains, :visible, :nth-match, :near, text=, xpath=). They throw at runtime.
- For INTERACTIVE / CONTROL roles (buttons, inputs, links, triggers, tabs): prefer durable hooks — id, data-testid / data-*, name, aria-label, role, type, semantic tags. AVOID nth-child chains, hashed/auto-generated class names, and long brittle descendant chains.
- CONTENT / STRUCTURAL roles (cards, tiles, rows, list items, sections, gallery/collection items — usually multiplicity "many") frequently have NO semantic hook: no id, no role, no aria, no data-*. For THESE, a CLASS-BASED selector is correct and expected — INCLUDING CSS-module / styled-component / "hashed" class names (e.g. "div.layout--JZpqG.column--FuwM5"), which are the element's ONLY stable handle. Do NOT avoid hashed classes for content roles. Do NOT route a content card through a clickable ancestor's child chain (e.g. "a[href*='/x/'] > div") — that breaks when the anchor wraps a label/icon; instead select the REPEATING element by its OWN class signature.
- REPEATING CONTENT BLOCKS may be listed near the top of the DOM listing — each is a structural element whose tag+class signature recurs N× on the page, with a "selector" ALREADY querySelector-verified to match N elements (plus count / has-image / sample-text). When a CONTENT or multiplicity-"many" role matches one (judge by sample-text, has-image, and count vs. the role's description), REUSE that "selector" VERBATIM — it is the single most reliable handle for that role.
- A BARE POSITIONAL selector on a generic tag (e.g. "button:nth-of-type(2)", "div > button:nth-child(3)") is almost always WRONG — it matches by POSITION, not meaning, and "matches one element" does NOT prove it's the right one. If the element has no stable hook, SCOPE the positional part under a stable/semantic ancestor (a landmark id, header/nav, [role=dialog], an aria-label'd container) so it cannot match the wrong element. For a TRIGGER role (one whose job is to OPEN something), a wrong target opens the wrong thing — be extra strict, and abstain rather than guess positionally.
- KNOWN VERIFIED SELECTORS may be provided below (captured by automated page exploration — each was confirmed to resolve, and triggers were confirmed to reveal content). When a role matches one, REUSE its selector VERBATIM — it is more reliable than anything you can infer from the DOM text.
- multiplicity "one"/"optional" → the selector must resolve to EXACTLY ONE element. multiplicity "many" → the selector must match the REPEATING item (multiple elements — e.g. the row/card that recurs), not one arbitrary instance.
- If a listed Ground landmark already matches a role, REUSE its selector verbatim.
- ABSTAIN with selector:null when no element on this page clearly plays the role. A wrong selector is worse than a gap — the user will pick it manually.
- Use the screenshot to judge which element is the right one (e.g. the visually prominent primary action) and what repeats.
- Return exactly one entry per provided role, in the same order.`;

    let rolesText = roleList.map(r =>
      `- role: ${r.role}\n  desc: ${(r.description ?? '').trim() || '(none)'}\n  multiplicity: ${r.multiplicity ?? 'one'}`
    ).join('\n');
    let userText = `Roles to resolve:\n${rolesText}\n\nURL: ${url ?? '(unknown)'}\nTitle: ${title ?? '(unknown)'}\n\nPage (sanitized DOM):\n${(domSnapshot ?? '').slice(0, 12000)}`;
    if (Array.isArray(registryLandmarks) && registryLandmarks.length) {
      const block = registryLandmarks.slice(0, 30).map(lm => {
        const role = lm?.a11yRole ? ` [${lm.a11yRole}]` : '';
        const sel  = lm?.selector ? ` => ${String(lm.selector).slice(0, 120)}` : '';
        const d    = lm?.description ? ` — ${String(lm.description).slice(0, 60)}` : '';
        return `- ${lm?.alias ?? '(no-alias)'}${role}${sel}${d}`;
      }).join('\n');
      userText += `\n\nLANDMARKS ALREADY CAPTURED ON THIS GROUND (reuse a selector verbatim if it matches a role):\n${block}`;
    }
    // v2.74.385 — Verified selectors from page exploration (pageStructure). Each
    // was confirmed to resolve; triggers were confirmed to actually reveal. Far
    // more reliable than inferring a positional selector from hashed-class DOM.
    if (Array.isArray(knownSelectors) && knownSelectors.length) {
      const block = knownSelectors.slice(0, 140).map(k => {
        const via = k?.via ? ` (revealed via "${String(k.via).slice(0, 30)}")` : '';
        // v2.74.447 — other-language labels (cross-locale harvest): the SAME element's text
        // in other languages, so a role/intent in any language matches this verified selector.
        const aliases = Array.isArray(k?.aliases) && k.aliases.length
          ? ` aka ${k.aliases.slice(0, 6).map(a => `"${String(a).slice(0, 30)}"`).join(' / ')}`
          : '';
        return `- "${String(k?.label ?? '').slice(0, 50)}" [${k?.role ?? '?'}]${aliases}${via} => ${String(k?.selector ?? '').slice(0, 140)}`;
      }).join('\n');
      userText += `\n\nKNOWN VERIFIED SELECTORS (from page exploration — REUSE verbatim when a role matches one, in ANY language via the "aka" aliases):\n${block}`;
    }
    // v2.74.415 — Site selector conventions, LEARNED from this Ground's verified
    // selectors across its Perspectives (OUTCOMES_SPEC § 6, the compounding asset). A
    // soft prior: when two candidate selectors are equally plausible, prefer the
    // tier this site actually uses. NOT a hard rule — a content role still takes a
    // class selector even on an id-heavy site.
    if (conventions?.selectorTierHistogram && conventions.total >= 5) {
      const TIER_DESC = { id: 'id', data: 'data-* / data-testid', aria: 'aria-* / role', class: 'class-based', semantic: 'semantic tag', positional: 'positional (nth-child)' };
      const dist = Object.entries(conventions.selectorTierHistogram)
        .filter(([, frac]) => frac > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([tier, frac]) => `${Math.round(frac * 100)}% ${TIER_DESC[tier] ?? tier}`)
        .join(', ');
      userText += `\n\nSITE SELECTOR CONVENTIONS (learned from ${conventions.total} verified selector(s) on this Ground): ${dist}. When two selectors are equally good for an INTERACTIVE role, prefer the dominant durable tier above. (Content/structural roles still use their own class signature regardless.)`;
    }
    // v2.74.356 — Repair pass: feed back verification verdicts so Claude
    // corrects what failed. Confirmed successes guide the site's conventions.
    if (priorAttempt && (priorAttempt.confirmed?.length || priorAttempt.attempts?.length)) {
      let rep = '\n\nTHIS IS A REPAIR PASS — your previous selectors were verified against the live page.';
      if (Array.isArray(priorAttempt.confirmed) && priorAttempt.confirmed.length) {
        rep += `\nAlready CONFIRMED working (do NOT return these — they show this site's selector conventions):\n` +
          priorAttempt.confirmed.map(c => `- ${c.role} => ${c.selector}`).join('\n');
      }
      if (Array.isArray(priorAttempt.attempts) && priorAttempt.attempts.length) {
        rep += `\nThese FAILED verification — for each, your prior selector + why it failed. Return a DIFFERENT, corrected selector (or null if genuinely unresolvable on this page):\n` +
          priorAttempt.attempts.map(a => `- ${a.role}: prior="${a.selector ?? '(none)'}" — failed: ${a.reason ?? 'unknown'}`).join('\n');
      }
      userText += rep;
    }

    const userContent = [];
    if (typeof screenshot === 'string') {
      const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(screenshot);
      if (m) {
        userContent.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
        userText += '\n\n(A screenshot of the current page is attached above.)';
      }
    }
    userContent.push({ type: 'text', text: userText });

    Logger.info('AnthropicService', `resolveRoles${priorAttempt ? ' [repair]' : ''} — ${roleList.length} role(s)`);

    let parsed;
    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 1200, [], { role: 'resolve', operation: priorAttempt ? 'resolveRoles:repair' : 'resolveRoles' });
      if (!raw?.success) { Logger.warn('AnthropicService', `resolveRoles failed: ${raw?.error}`); return null; }
      const json = AnthropicService.#firstJsonObject(raw.text);
      if (!json) { Logger.warn('AnthropicService', 'resolveRoles: no JSON'); return null; }
      parsed = JSON.parse(json);
    } catch (e) {
      Logger.warn('AnthropicService', `resolveRoles error: ${e.message}`);
      return null;
    }

    // ── Sanitizer: align to the requested roles; reject non-CSS selectors. ──
    const byRole = new Map();
    for (const r of Array.isArray(parsed.resolutions) ? parsed.resolutions : []) {
      if (r && typeof r.role === 'string') byRole.set(r.role.trim(), r);
    }
    const resolutions = roleList.map(({ role }) => {
      const r = byRole.get(role) ?? null;
      let selector = (r && typeof r.selector === 'string') ? r.selector.trim() : null;
      if (selector && _looksLikePlaywrightSelector(selector)) {
        Logger.warn('AnthropicService', `resolveRoles: dropping non-CSS selector for "${role}": ${selector.slice(0, 120)}`);
        selector = null;
      }
      if (!selector) selector = null;
      const confidence = (r && typeof r.confidence === 'number') ? Math.max(0, Math.min(1, r.confidence)) : 0;
      const justification = (r && typeof r.justification === 'string') ? r.justification.trim().slice(0, 160) : '';
      return { role, selector, confidence, justification };
    });
    return { resolutions };
  }

  /**
   * v2.74.364 — Visual critic for structure verification: adjudicate the
   * residual claims that deterministic checks couldn't settle (portaled
   * containment, DOM-invisible trigger reveals) against a screenshot. STRICT —
   * say "no" when the relationship isn't visually supported; deterministic
   * verdicts stay authoritative, this only touches the residual. classify role.
   *
   * @param {{ claims: Array<{id:string, kind:'containment'|'trigger', text:string}>, screenshot?:string|null }} params
   * @returns {Promise<{ verdicts: Array<{id:string, hold:'yes'|'no'|'unsure', reason:string}> }|null>}
   */
  static async adjudicateStructure({ claims, screenshot }) {
    const list = (Array.isArray(claims) ? claims : []).filter(c => c && typeof c.id === 'string' && typeof c.text === 'string');
    if (list.length === 0) return null;

    const systemPrompt = `You are a STRICT critic verifying claims about a web page's structure against a screenshot. Each claim asserts either a CONTAINMENT relationship (one element visually belongs inside/with another — e.g. a dropdown menu belongs to its control, even when rendered as a floating popup) or a TRIGGER reveal (activating a control made another element appear). For each claim, judge whether the screenshot SUPPORTS it.

Return ONLY JSON: { "verdicts": [ { "id": "<claim id>", "hold": "yes" | "no" | "unsure", "reason": "<short>" } ] }

Rules:
- "yes" only when the screenshot clearly supports the claim (the elements are visible and the relationship is evident — e.g. the menu sits directly under/over its control, or the revealed element is now visible).
- "no" when the screenshot contradicts it (elements visible but unrelated/elsewhere, or the supposedly-revealed element isn't visible).
- "unsure" when the relevant elements aren't clearly identifiable in the screenshot — do NOT guess.
- Be strict: a wrong "yes" is worse than "unsure". One verdict per claim id.`;

    let text = `Claims:\n${list.map(c => `- id ${c.id} [${c.kind}]: ${c.text}`).join('\n')}`;
    const userContent = [];
    if (typeof screenshot === 'string') {
      const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(screenshot);
      if (m) { userContent.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }); text += '\n\n(A screenshot of the current page state is attached above.)'; }
    }
    userContent.push({ type: 'text', text });

    let parsed;
    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 900, [], { role: 'classify', operation: 'adjudicateStructure' });
      if (!raw?.success) { Logger.warn('AnthropicService', `adjudicateStructure failed: ${raw?.error}`); return null; }
      const json = AnthropicService.#firstJsonObject(raw.text);
      if (!json) { Logger.warn('AnthropicService', 'adjudicateStructure: no JSON'); return null; }
      parsed = JSON.parse(json);
    } catch (e) {
      Logger.warn('AnthropicService', `adjudicateStructure error: ${e.message}`);
      return null;
    }
    const HOLD = new Set(['yes', 'no', 'unsure']);
    const verdicts = (Array.isArray(parsed.verdicts) ? parsed.verdicts : [])
      .filter(v => v && typeof v.id === 'string')
      .map(v => ({ id: v.id, hold: HOLD.has(v.hold) ? v.hold : 'unsure', reason: (typeof v.reason === 'string' ? v.reason.trim() : '').slice(0, 120) }));
    return { verdicts };
  }

  /**
   * v2.74.61 — Distill a captured section into a curated list. The
   * Observation Section extract shape uses this for its Text / URL
   * modes:
   *   - text mode: return the meaningful, distinct text values present
   *     in the section (titles, names, prices, labels — not stop
   *     phrases or boilerplate). Input is the section's markdown +
   *     plain text.
   *   - url mode: return the meaningful, navigable URLs from the
   *     section's link list. Skip anchors, mailto, javascript:, and
   *     near-duplicates.
   *
   * Returns an array of strings. Empty array if no useful values.
   *
   * @param {Object} options
   * @param {'text'|'url'} options.mode
   * @param {Object} options.section  output of content-script OBSERVE_SECTION
   * @param {string} [options.sourceUrl]
   * @returns {Promise<{ items: string[] } | null>}
   */
  static async extractSectionItems({ mode, section, sourceUrl }) {
    if (!section || typeof section !== 'object') return null;
    const isUrl = mode === 'url';
    const systemPrompt = isUrl
      ? `You distill a webpage section's link list into a curated array of meaningful URLs.

Return ONLY a JSON object with this shape:
{ "items": ["https://...", "https://...", ...] }

Rules:
- Keep navigable hyperlinks that lead to real pages or resources.
- Skip same-page anchors (href starts with "#"), mailto:, tel:, javascript:.
- Skip near-duplicates (same URL with only tracking-param differences).
- Resolve relative URLs against the sourceUrl when one is provided.
- Preserve the original ordering of the first occurrence of each URL.
- If nothing useful is present, return { "items": [] }.`
      : `You distill a webpage section's text content into a curated array of meaningful text values.

Return ONLY a JSON object with this shape:
{ "items": ["...", "...", ...] }

Rules:
- Include user-facing strings that carry real information: titles, product names, headings, prices, button labels, person names, key descriptors.
- Skip boilerplate ("Sign in", "Cookie consent", footer chrome, navigation), repeated UI strings, and stop phrases.
- Deduplicate. Preserve the order of first occurrence.
- Trim whitespace. Keep punctuation that's part of the value.
- If nothing useful is present, return { "items": [] }.`;

    const sectionPayload = isUrl
      ? {
          links : (section.links ?? []).slice(0, 200).map(l => ({
            href : l.href ?? '',
            text : (l.text ?? '').trim().slice(0, 200),
            title: l.title ?? '',
          })),
        }
      : {
          markdown : String(section.markdown ?? '').slice(0, 10000),
          text     : String(section.text     ?? '').slice(0, 6000),
        };

    const userContent = [{
      type: 'text',
      text:
        `Source URL: ${sourceUrl ?? '(unknown)'}\n` +
        `Mode: ${isUrl ? 'URLs' : 'Text values'}\n\n` +
        `Section payload:\n${JSON.stringify(sectionPayload, null, 2)}`,
    }];

    Logger.info('AnthropicService', `extractSectionItems — mode=${isUrl ? 'url' : 'text'}`);

    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 1500);
      if (!raw?.success) {
        Logger.warn('AnthropicService', `extractSectionItems failed: ${raw?.error}`);
        return null;
      }
      let text = String(raw.text ?? '').trim();
      const firstBrace = text.indexOf('{');
      const lastBrace  = text.lastIndexOf('}');
      if (firstBrace < 0 || lastBrace < firstBrace) {
        Logger.warn('AnthropicService', `extractSectionItems no JSON: ${text.slice(0, 200)}`);
        return null;
      }
      text = text.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed.items)
        ? parsed.items.map(s => String(s ?? '').trim()).filter(Boolean)
        : [];
      return { items };
    } catch (e) {
      Logger.warn('AnthropicService', `extractSectionItems error: ${e.message}`);
      return null;
    }
  }

  /**
   * v2.74.62 — Vision read of a cropped screenshot. The Observation
   * Image (read) extract shape uses this: the author drags a region,
   * writes a description of what they want extracted, and Verify
   * sends image + description here. Claude returns an array of
   * strings matching the description.
   *
   * Returns { items: string[] } — empty when Claude finds nothing.
   *
   * @param {Object} options
   * @param {string} options.description    — author's instruction
   * @param {string} options.imageDataUrl   — "data:image/png;base64,..."
   * @returns {Promise<{ items: string[] } | null>}
   */
  static async readImage({ description, imageDataUrl }) {
    if (!description || typeof description !== 'string' || !description.trim()) {
      return null;
    }
    if (!imageDataUrl || typeof imageDataUrl !== 'string') return null;
    const match = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(imageDataUrl);
    if (!match) {
      Logger.warn('AnthropicService', `readImage: imageDataUrl is not a base64 data URL`);
      return null;
    }
    const mediaType = match[1];
    const base64    = match[2];

    const systemPrompt = `You read images and extract structured values requested by the user.

You receive:
  - An image (cropped region of a web page).
  - A description of what the user wants extracted from that image.

Return ONLY a JSON object with this shape:
{
  "items":      ["...", "...", ...],
  "confidence": 0.0,
  "rationale":  "..."
}

Rules:
- "items" is an array of distinct string values matching the user's description.
- If the description asks for a single value (e.g. "the total amount"), return a one-element array with that value.
- If the description asks for a list (e.g. "all visible prices", "every product name"), return one entry per match in the order they appear in the image (top-to-bottom, left-to-right).
- Trim whitespace. Keep punctuation that's part of the value.
- Skip clearly-decorative or non-text-rendered elements unless explicitly asked.
- If nothing in the image satisfies the description, return { "items": [], "confidence": 0, "rationale": "..." }.
- Never invent values not visible in the image.

- "confidence" is a number between 0 and 1 reflecting how sure you are the items satisfy the description. 1 = highly confident; 0 = the image does not permit a confident answer. Subjective, not calibrated.
- "rationale" is one short sentence explaining the selection. When items is empty, explain why nothing matched (e.g. "the cropped region does not contain the expected D.R. Horton prefix").`;

    const userContent = [
      {
        type   : 'image',
        source : { type: 'base64', media_type: mediaType, data: base64 },
      },
      {
        type: 'text',
        text: `Description (what to read from the image):\n${description.trim()}`,
      },
    ];

    Logger.info('AnthropicService', `readImage — desc="${description.slice(0, 80)}"`);

    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 1500);
      if (!raw?.success) {
        Logger.warn('AnthropicService', `readImage failed: ${raw?.error}`);
        return null;
      }
      const rawText = String(raw.text ?? '').trim();
      let text = rawText;
      const firstBrace = text.indexOf('{');
      const lastBrace  = text.lastIndexOf('}');
      if (firstBrace < 0 || lastBrace < firstBrace) {
        Logger.warn('AnthropicService', `readImage no JSON: ${text.slice(0, 200)}`);
        return null;
      }
      text = text.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(text);
      const itemsRaw = Array.isArray(parsed.items) ? parsed.items : [];
      const items = itemsRaw
        .map(s => String(s ?? '').trim())
        .filter(Boolean);

      // v2.74.154 — Confidence + rationale metadata. Optional in the
      // schema — older Claude responses (or non-conforming ones) just
      // get nulls and the binding still works.
      const confidence = (typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence))
        ? Math.max(0, Math.min(1, parsed.confidence))
        : null;
      const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';

      // v2.74.154 — Cost metadata. Computed from token usage returned by
      // #call against the pricing table at the top of this module.
      // Forwarded to callers; ExecutionEngine logs it in the OBSERVATION
      // line so cost is recoverable from the Logs tab per-step.
      const usage = raw.usage ?? { inputTokens: 0, outputTokens: 0 };
      const cost  = estimateCostUSD(MODEL, usage);

      // v2.74.150 — Diagnostic logging when Claude returns nothing usable.
      // Pre-v2.74.150 the call was effectively silent once it succeeded.
      // Three distinguishable causes when items=[]:
      //   1. parsed.items === []         → Claude found nothing
      //   2. parsed.items === ['', ' '] → blanks filtered out
      //   3. parsed.items missing       → schema ignored
      // The raw-text log + the new confidence/rationale fields together
      // pin the cause quickly.
      if (items.length === 0) {
        const rawSummary = rawText.length > 240 ? rawText.slice(0, 237) + '…' : rawText;
        Logger.info('AnthropicService',
          `readImage returned 0 items — raw=${itemsRaw.length} (after-trim drop=${itemsRaw.length - items.length}), ` +
          `confidence=${confidence ?? 'n/a'}. Response: ${rawSummary}`);
      } else {
        Logger.debug?.('AnthropicService',
          `readImage returned ${items.length} item(s); first="${items[0].slice(0, 60)}", ` +
          `confidence=${confidence ?? 'n/a'}`);
      }
      // v2.74.154 — Always log a cost line at INFO (one per LLM
      // observation call) so the Logs tab tracks spend per run without
      // having to enable DEBUG.
      // v2.74.159 — Also gate on a positive token count. The defensive
      // fallback `raw.usage ?? { 0, 0 }` would otherwise produce a
      // `$0.00000 (in 0t, out 0t)` log line on the unlikely API path
      // that returns no usage block — cosmetic noise with no signal.
      if (cost && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
        Logger.info('AnthropicService',
          `readImage cost: $${cost.total.toFixed(5)} ` +
          `(in ${usage.inputTokens}t @ $${cost.input.toFixed(5)}, out ${usage.outputTokens}t @ $${cost.output.toFixed(5)})`);
      }
      return {
        items,
        confidence,
        rationale,
        usage,
        cost,           // {input, output, total} in USD, or null if model not in pricing table
        model: MODEL,
      };
    } catch (e) {
      Logger.warn('AnthropicService', `readImage error: ${e.message}`);
      return null;
    }
  }

  static async classifyPage({ url, title, domSnapshot }) {
    if (!url || !domSnapshot) return null;

    const systemPrompt = `You are a web page classifier helping build a structural map of a web app. Given a page's URL and a compact DOM snapshot, return a JSON classification.

Return ONLY a JSON object with exactly these fields:
{
  "pageType": "list" | "detail" | "form" | "confirmation" | "other",
  "formFields": [ { "label": "...", "selector": "...", "type": "...", "required": true/false } ],
  "outgoingLinks": [ { "text": "...", "href": "..." } ]
}

Classification rules:
- "form": page has a prominent input form (not just a search box). Include each field with its visible label.
- "list": page shows a repeating collection of similar items (tickets, jobs, records). Not a search results page.
- "detail": page shows a single structured entity (one ticket, one order, one profile).
- "confirmation": page shows a completed-action state ("Thank you", "Submitted", success iconography).
- "other": doesn't fit the above (homepage, settings index, marketing page).

For formFields:
- Include only visible, non-hidden inputs (skip type=hidden, skip search boxes)
- "selector" should use real DOM attributes (id, name, or a stable class chain) — never synthetic annotations
- "label" is the visible label text associated with the field
- "type" is the input's HTML type (text, email, select, checkbox, etc.)
- "required" reflects the required attribute when visible

For outgoingLinks:
- Include <a href> links that lead to meaningful app pages (not footer/nav/external)
- Max 8 most prominent links
- Skip links whose text contains "delete", "sign out", "logout" — these are action links, not exploration targets

If this page has none of the above features, return empty arrays.`;

    const userContent = [
      { type: 'text', text: `URL: ${url}\nTitle: ${title ?? '(untitled)'}\n\nDOM snapshot:\n${String(domSnapshot).slice(0, 12000)}` },
    ];

    Logger.info('AnthropicService', `classifyPage — ${url}`);

    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 1000);
      if (!raw?.success) {
        Logger.warn('AnthropicService', `classifyPage failed: ${raw?.error}`);
        return null;
      }
      let text = String(raw.text ?? '').trim();
      const firstBrace = text.indexOf('{');
      const lastBrace  = text.lastIndexOf('}');
      if (firstBrace < 0 || lastBrace < firstBrace) {
        Logger.warn('AnthropicService', `classifyPage returned no JSON: ${text.slice(0, 200)}`);
        return null;
      }
      text = text.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(text);

      return {
        pageType      : parsed.pageType ?? 'other',
        title         : title ?? '',
        formFields    : Array.isArray(parsed.formFields)    ? parsed.formFields    : [],
        outgoingLinks : Array.isArray(parsed.outgoingLinks) ? parsed.outgoingLinks : [],
      };
    } catch (e) {
      Logger.warn('AnthropicService', `classifyPage error: ${e.message}`);
      return null;
    }
  }

  /**
   * Pass 5b — Generate DETECT branch conditions from fork-point observations.
   *
   * After a Fork-enabled Walk completes, ProcedureBuilder emits a DETECT
   * node with stub conditions. This method takes the recorded fork point
   * observations and synthesizes a real condition per branch — typically a
   * selector_present on a distinguishing element, or url_matches when the
   * branches diverge by route.
   *
   * Returns a map { branchLabel → condition } that the caller uses to
   * replace stub conditions before persisting the Procedure.
   *
   * @param {Object} options
   * @param {Array<{ label: string, parentStepIdx: number, domObservation: string }>} options.forkPoints
   * @returns {Promise<Object<string, { type: string, selector?: string, pattern?: string }>>}
   */
  static async generateDetectConditions({ forkPoints }) {
    if (!Array.isArray(forkPoints) || forkPoints.length === 0) {
      return {};
    }

    const systemPrompt = `You generate DETECT branch conditions for a web automation procedure. The user walked an application and declared branch points where execution splits based on page state. For each branch, you must generate a condition that will be true at runtime ONLY when this branch should be taken.

Return ONLY a JSON object shaped like:
{
  "<branch_label>": { "type": "selector_present", "selector": "..." },
  "<branch_label>": { "type": "url_matches", "pattern": "..." }
}

Condition types available:
- { "type": "selector_present", "selector": "..." }  — a CSS selector matches at least one element
- { "type": "selector_absent", "selector": "..." }   — no match
- { "type": "url_matches", "pattern": "..." }        — window.location.href matches a regex
- { "type": "text_present", "text": "..." }          — case-insensitive substring in body text

Rules:
- Prefer selector_present when branches are distinguished by DOM elements unique to each branch.
- Prefer url_matches when branches are distinguished by URL patterns.
- Selectors must use real DOM attributes (id, data-*, role, aria-*). Never fabricate selectors.
- Conditions should be mutually exclusive across branches so only one matches at runtime.
- If you cannot confidently pick a condition, use { "type": "selector_present", "selector": "" } — the user will fill it in manually.`;

    const branchSummaries = forkPoints.map(fp => {
      return `Branch: "${fp.label}"\nDOM observation at fork point:\n${String(fp.domObservation ?? '').slice(0, 4000)}`;
    }).join('\n\n---\n\n');

    const userContent = [{ type: 'text', text: branchSummaries }];

    Logger.info('AnthropicService', `generateDetectConditions — ${forkPoints.length} branch(es)`);

    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 800);
      if (!raw?.success) {
        Logger.warn('AnthropicService', `generateDetectConditions failed: ${raw?.error}`);
        return {};
      }
      let text = String(raw.text ?? '').trim();
      const firstBrace = text.indexOf('{');
      const lastBrace  = text.lastIndexOf('}');
      if (firstBrace < 0 || lastBrace < firstBrace) return {};
      text = text.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(text);
      // Must be a plain object — reject arrays and primitives
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) {
      Logger.warn('AnthropicService', `generateDetectConditions error: ${e.message}`);
      return {};
    }
  }

  /**
   * Generate a short conversation title from the first user message.
   * Used by the chat UI to name persisted conversations. Returns null
   * on failure — caller should fall back to truncating the message.
   *
   * @param {string} firstMessage - The first user message in the conversation
   * @returns {Promise<string|null>}  Title (4-6 words, no punctuation) or null
   */
  /**
   * v2.74.229 — Picker-loop selector refinement. Authors hit this when the
   * picker's auto-generated selector targets the wrong element or is
   * fragile (hashed classes, positional :nth-of-type). Given the inspect
   * report for the currently-targeted element plus the author's intent
   * (shape), Claude returns a more stable CSS selector.
   *
   * Inputs (all optional except shape + outerHTMLPreview):
   *   - shape:                  the extract shape ('click_copy_last',
   *                             'text_last', 'text', etc.). Drives
   *                             intent — interactive vs read, last-match
   *                             semantics, etc.
   *   - currentSelector:        the existing selector to refine
   *   - matchCount, matchIndex, pickLastUsed: from inspect report
   *   - outerHTMLPreview:       matched element's outerHTML (truncated)
   *   - parentOuterHTMLPreview: parent's outerHTML for sibling context
   *   - frame:                  'top' or 'iframe — <url>'
   *
   * Returns: { success, selector, error, usage }
   */
  static async suggestSelector({
    shape = '',
    currentSelector = '',
    matchCount = null,
    matchIndex = null,
    pickLastUsed = false,
    outerHTMLPreview = '',
    parentOuterHTMLPreview = '',
    frame = 'top',
    // v2.74.233 — Optional cropped screenshot of the element region.
    // When provided, the model gets visual + structural context — far
    // more reliable for disambiguating similar elements (e.g. which
    // of two visually-identical buttons is the "Save" vs "Submit"
    // when both share styled-components classes).
    screenshotDataUrl = null,
  } = {}) {
    if (!outerHTMLPreview) {
      return { success: false, selector: '', error: 'no outerHTMLPreview provided — cannot suggest without DOM context' };
    }

    const systemPrompt = `You are a CSS selector expert. Given an HTML element and the author's intent (and possibly a cropped screenshot of the element region), output the most STABLE CSS selector that uniquely identifies the right element.

WHEN A SCREENSHOT IS PROVIDED:
Use it to disambiguate. The element the author wants is the one their cursor was on — described by the outerHTML AND the visible appearance in the image. If multiple DOM elements match the structural pattern, prefer the one whose visual context matches the author's intent (e.g. role "search input" → the visible <input> with a search icon, not a hidden one).

PRIORITIES (highest first):
1. Stable attribute selectors: [data-test-id="..."], [data-qa="..."], [aria-label="..."], [role="..."], #id (only when id is a human-readable slug, NOT a hash/UUID).
2. Human-readable class-prefix matching: [class*="MarkdownBlock-"] when the prefix is meaningful and stable.
3. Tag + attribute combinations: button[aria-label="Copy message"].
4. AVOID: hashed class suffixes (random 4-8 char tokens like .kuAzXQ, .gKiNOa), positional :nth-of-type chains, deep > combinators with no anchor.

SHAPE / INTENT-SPECIFIC GUIDANCE:
- "click_copy_last" / "click_copy": prefer an interactive ancestor (<button>, [role="button"], <a>). The click target should carry the onClick handler. Look for aria-label containing "copy" or icon-name attributes like data-icon-name="Copy".
- "click" (fragment action): prefer an interactive ancestor. Target the element with the onClick handler, NOT cosmetic children (spans, icons inside the button).
- "click_by_label" (fragment action): the selector targets a CONTAINER element holding interactive items (menu, list, dropdown). Match the container, not individual items.
- "type" (fragment action): the selector must target an actual <input>, <textarea>, or [contenteditable] element — not a wrapper. The runtime calls .focus() and dispatches keystrokes against it.
- "select" (fragment action): the selector should target a <select> element directly.
- "wait_for" / "wait_for_gone" (fragment action): general presence/absence; the selector matches the element whose appearance/disappearance is the signal.
- "scroll_to" (fragment action): target the element to scroll into view.
- "text_last": runtime will querySelectorAll().last, so emit a selector that matches every item in the feed — don't over-scope. Prefer the prose-bearing element (markdown block, message body), not a wrapper.
- "text": one element only. Be specific enough to disambiguate but no more.
- For any "_last" shape: the selector should match N items (one per feed entry), not just the latest. The runtime picks the latest from the list.

Output ONLY the CSS selector as a single line. No backticks, no quotes, no "Here's the selector:". Just the selector.`;

    const matchInfo = matchCount != null
      ? `Current match count: ${matchCount}${pickLastUsed && matchIndex != null ? ` (last-match picked at index ${matchIndex})` : ''}`
      : '';

    const userText = [
      `Author's intent (shape): ${shape || '(unspecified)'}`,
      currentSelector ? `Current selector: ${currentSelector}` : '',
      matchInfo,
      `Frame: ${frame}`,
      '',
      'Matched element outerHTML:',
      outerHTMLPreview,
      '',
      parentOuterHTMLPreview ? 'Parent element outerHTML (provides sibling context):' : '',
      parentOuterHTMLPreview,
    ].filter(Boolean).join('\n');

    // v2.74.233 — Parse the screenshot data URL into the base64 +
    // media type Anthropic expects. Skip silently if malformed so
    // selector-suggestion still runs with text-only context.
    let imageContent = null;
    if (screenshotDataUrl && typeof screenshotDataUrl === 'string') {
      const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(screenshotDataUrl);
      if (m) {
        imageContent = {
          type: 'image',
          source: { type: 'base64', media_type: m[1], data: m[2] },
        };
      } else {
        Logger.warn('AnthropicService', 'suggestSelector: screenshotDataUrl not a base64 data URL — skipping');
      }
    }

    Logger.info('AnthropicService', `suggestSelector — shape=${shape} current="${(currentSelector || '').slice(0, 80)}" screenshot=${imageContent ? 'yes' : 'no'}`);

    // Image content goes before text content in Anthropic's API for
    // best comprehension (vision attention pre-conditions on the
    // image, then reads instructions in context).
    const userContent = imageContent
      ? [imageContent, { type: 'text', text: userText }]
      : [{ type: 'text', text: userText }];

    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 300, [], { role: 'resolve', operation: 'suggestSelector' });
      if (!raw?.success) {
        Logger.warn('AnthropicService', `suggestSelector failed: ${raw?.error}`);
        return { success: false, selector: '', error: raw?.error ?? 'unknown' };
      }
      // Normalize: strip code fences, trim, take last non-empty line
      // (Claude usually outputs one line; this defends against any
      // "Here's the selector:\n<selector>" preamble).
      let selector = String(raw.text ?? '').trim();
      selector = selector.replace(/^```(?:css)?\s*/i, '').replace(/\s*```$/i, '').trim();
      const lines = selector.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (lines.length > 0) selector = lines[lines.length - 1];
      // Strip wrapping quotes if Claude added them.
      selector = selector.replace(/^["']+|["']+$/g, '').trim();
      if (!selector) {
        return { success: false, selector: '', error: 'Claude returned empty selector' };
      }
      return { success: true, selector, error: null, usage: raw.usage };
    } catch (err) {
      Logger.warn('AnthropicService', `suggestSelector error: ${err.message}`);
      return { success: false, selector: '', error: err.message };
    }
  }

  /**
   * v2.74.235 — Wave 2 of the landmark SSOT project. Generates a full
   * profile in one Claude call: refined selector + human description +
   * aliases + typical operations + pitfalls + expected content kind.
   * Persisted on the landmark record so downstream consumers (fragment
   * actions, observation extracts) get rich, self-describing landmarks
   * without re-running anything.
   *
   * Returns:
   *   { success, profile, error, usage }
   *   profile: {
   *     selector,
   *     description,            // 1-2 sentences in second person
   *     aliases,                // 0-5 alternate names
   *     operationsCommon,       // 2-4 most-likely ops
   *     pitfalls,               // gotchas, empty array ok
   *     expectedContent,        // { kind, format?, example? } or null
   *     confidence,             // 0-1, self-reported
   *     rationale,              // one-sentence justification
   *   }
   *
   * @param {object} args
   * @param {string} args.role
   * @param {string} args.currentSelector       picker's raw selector
   * @param {object} args.fingerprint           rule-based capabilities + element shape
   * @param {string} args.outerHTMLPreview
   * @param {string} args.parentOuterHTMLPreview
   * @param {string} args.frame
   * @param {number} args.matchedCount
   * @param {string|null} args.screenshotDataUrl
   * @param {string[]} args.operationsAllowed   the rule-derived allowlist
   */
  static async generateLandmarkProfile({
    role = '',
    currentSelector = '',
    fingerprint = null,
    outerHTMLPreview = '',
    parentOuterHTMLPreview = '',
    frame = 'top',
    matchedCount = null,
    screenshotDataUrl = null,
    operationsAllowed = [],
  } = {}) {
    if (!outerHTMLPreview) {
      return { success: false, profile: null, error: 'no outerHTMLPreview provided' };
    }

    const systemPrompt = `You are building a landmark profile for a browser-automation authoring tool. A "landmark" is a named, reusable reference to a DOM element. Downstream consumers (fragment actions like CLICK / TYPE; observation extracts like text / attribute) will reference this landmark by name and trust the profile WITHOUT re-running their own checks.

Output ONE JSON object. No prose around it, no markdown code fences, no explanation — just the JSON.

Schema:
{
  "selector": "<stable CSS selector>",
  "description": "<1-2 sentences, second person, what this element is and what it does>",
  "aliases": ["<alternate names users might call this>", ...],
  "operationsCommon": ["<typical ops>", ...],
  "pitfalls": ["<real gotchas>", ...],
  "expectedContent": { "kind": "<text|date|number|url|list|image>", "format": "<optional>", "example": "<optional>" } | null,
  "effect": {
    "kind": "<none | opens-new-thread | triggers-navigation | triggers-modal | triggers-download>",
    "form": "<tab|window|popup|sidebar>",   // ONLY when kind == opens-new-thread
    "modalKind": "<alert|confirm|prompt>"   // ONLY when kind == triggers-modal
  },
  "interactionPattern": "<none | opens-menu | switches-tab | toggles-expansion | toggles-state | submits-in-place | mutates-page>",
  "confidence": <0-1>,
  "rationale": "<one sentence>"
}

SELECTOR rules (v2.74.298 — visual reasoning enabled):

The substrate now SHOWS YOU the picked element visually: the screenshot is a wider context shot of the page region around the picked element, with a RED RECTANGLE drawn directly on the picked element's exact pixel location. Use this red rectangle as your "you are here" marker.

Two scenarios drive your selector decision:

  (i) Picker selector resolves UNIQUELY (matchedCount === 1):
      Default behavior is to ECHO the picker's selector. Only propose
      a different selector if you can demonstrate it's STRICTLY more
      stable — e.g., picker is a long structural chain and you spot
      an aria-label / data-test-id on the SAME element.

  (ii) Picker selector is AMBIGUOUS (matchedCount > 1):
       This is the high-value case. The picker's selector matches
       N elements but the user picked ONE specific element — the one
       inside the red rectangle. Your job: propose a selector that
       uniquely identifies the highlighted element among the N matches.

       Use the screenshot to find what makes the highlighted element
       different from its siblings: a nearby label, a unique badge or
       icon, position in a row, surrounding chrome. Then encode that
       difference in CSS — preferring stable signals (data-* attrs,
       aria-labels) over positional ones, but :nth-of-type / :nth-child
       is acceptable when there's no stable discriminator.

VERIFICATION — your selector is checked geometrically (v2.74.298):

The substrate runs your selector through document.querySelectorAll. To
be accepted:
  - It must match EXACTLY 1 element.
  - That element's bounding rect must overlap the picker's pickedRect
    with IoU ≥ 0.8, OR its a11y UID must match the picker's UID.

This means: you can be ambitious about visual-cue-based selectors
(spotting the right element from siblings using the highlight + page
layout) because the gate is "does your selector point to the same
element the user clicked?", not "is your selector's discriminator
tier strictly better than the picker's?". A selector that uniquely
picks the right element wins — even if it's a positional chain — over
a tier-better selector that picks the wrong one.

If your selector picks a different element than the highlighted one,
the substrate keeps the picker's selector and your proposal is
discarded. So when in doubt, echo the picker.

Output rules:
- Pure CSS, usable by document.querySelectorAll. No Playwright /
  Cypress / jQuery extensions.
- NEVER use these — they are NOT valid CSS and will throw at runtime:
    :has-text(...), :text(...), :text-is(...), :text-matches(...), :contains(...),
    :visible, :hidden, :light(...), :scope=..., text=..., xpath=..., css=...,
    :near(...), :nth-match(...), :right-of(...), :left-of(...), :above(...), :below(...).
- Avoid hashed class suffixes (random 4-8 char tokens) UNLESS they're
  the only discriminator available — :nth-of-type or aria-label is
  almost always preferable.

DESCRIPTION rules:
- Second person: "the input you'd type a search query into", NOT "this is a search input".
- 1-2 sentences, max ~30 words.
- Describe purpose AND visible context (e.g. "the green Send button at the bottom-right of the message composer").
- The screenshot is a wider context shot of the surrounding page region. A RED RECTANGLE marks the picked element's exact pixel-location — anything outside the rectangle is contextual chrome (siblings, headings, sticky bars). Use the surrounding chrome to describe the element's purpose; use the rectangle to identify which element you're profiling.

CRITICAL — VALUE-TEXT vs PURPOSE-LABEL (read this carefully):
The picked element's own text (and accessibleName from AccName) is often its CURRENT VALUE,
not the control's name. Filter dropdown reading "All images", sort selector reading "Most
recent", tab strip selection reading "Inbox", settings toggle reading "On" — all of these are
VALUES, not control names.

For these patterns, the control's purpose label is usually VISIBLE in the screenshot near
the highlighted rectangle: a heading above the row, a sibling label to the left, a section
title that groups the control, a NEW/badge chip indicating selection state. Look for it in
the screenshot first; fall back to parentOuterHTMLPreview only when the screenshot doesn't
make it visible.

When you detect this pattern:
- Description must reference the PURPOSE inferred from parent/sibling DOM, not the value
  text: "the Content type filter dropdown, currently showing 'All images'." NOT "the
  'All images' dropdown button."
- accessibleName from the AccName algorithm is the value — useful as a current-state clue,
  not as the control's identity.
- Pitfall to include: "Button text reflects the currently-selected option and changes when the
  user picks a different value; selectors based on the value text will break."
- If parent DOM doesn't yield a clear purpose label, fall back to describing what the
  element appears to do based on its surrounding structural context — do NOT manufacture
  one from the value text alone.

ALIASES — same rule. Aliases reflect the control's PURPOSE, not its current value:
- A "Content type" filter currently showing "All images" → aliases ["content-type-filter",
  "image-type-filter", "media-type-selector"] are about the filter's purpose. Aliases like
  "all-images" or "all-images-button" embed the current value into the identity and become
  wrong the moment the user picks "Photos".

ALIASES:
- 0-5 alternate names a different author might call this landmark.
- Lowercase-hyphenated, same convention as the role.
- For role "send-message" → aliases ["send", "submit-message", "post-message"].
- Empty array is fine when the role is already canonical.

OPERATIONS COMMON:
- Pick 2-4 from the ALLOWED list (provided in the user message) that authors would MOST LIKELY reach for.
- Don't repeat every allowed op — just the top picks.
- Order by likelihood, most common first.

PITFALLS:
- Only REAL gotchas you can see in the DOM context, not hypothetical ones.
- Examples that count:
    "Only rendered when parent message has hover state — Fragment authors must simulate hover before CLICK."
    "Inside a virtualized list — element may be unmounted if scrolled off-screen."
    "Disabled until form is dirty — TYPE in a sibling input first."
    "Re-renders on every keystroke — selectors using runtime-generated classes will break."
- Empty array when there are no real pitfalls. Don't manufacture them.

EXPECTED CONTENT:
- Only for landmarks whose downstream operations include extraction (text, attribute, section, list_of_records).
- null for pure action landmarks (buttons, links, type-only inputs).
- kind: text | date | number | url | list | image
- format: optional pattern when meaningful ("MM/DD/YYYY", "$NN.NN", "+1 XXX-XXX-XXXX").
- example: a snippet from the current DOM if visible.

EFFECT + INTERACTION PATTERN (v2.74.305 — split for spec compliance):

These are TWO ORTHOGONAL signals. Fill in both.

═══ "effect" — SUBSTRATE-LEVEL BROWSER EFFECT ═══

What happens at the BROWSER LEVEL — beyond the DOM — when this Action runs?
ACTION_SPEC § 5 defines exactly five effect kinds. Pick one.

- { kind: "none" }                       — default. Element interaction stays
                                            inside the page. A button that opens
                                            a DOM dropdown, a tab that swaps
                                            content, a checkbox that toggles
                                            state — all "none". The DOM changes;
                                            the browser doesn't.

- { kind: "opens-new-thread", form: ... } — opens in a new browser thread.
                                            form is one of:
                                              "tab"     — new browser tab
                                                          (target="_blank",
                                                          chrome.tabs.create)
                                              "window"  — new browser window
                                              "popup"   — window.open with
                                                          popup features
                                              "sidebar" — side panel

- { kind: "triggers-navigation" }        — clicking changes window.location.href
                                            (full nav or SPA route change).
                                            Anchor with real href, form submit
                                            with action attribute.

- { kind: "triggers-modal", modalKind: ... } — BROWSER modal — alert/confirm/
                                            prompt dialog from window.alert,
                                            window.confirm, window.prompt.
                                            NOT a DOM <dialog> or [role=dialog]
                                            (those are interactionPattern
                                            "opens-menu"). modalKind is one
                                            of "alert" | "confirm" | "prompt".

- { kind: "triggers-download" }          — initiates a file download (download
                                            attribute, href to a binary file,
                                            button labeled "Export" / "Download
                                            CSV").

If unsure, return { kind: "none" }. The author / runtime observation will refine.

═══ "interactionPattern" — DOM-LEVEL INTERACTION SHAPE ═══

What KIND of in-page interaction does this control offer? This is separate
from effect — most DOM patterns have effect.kind = "none". Pick one:

- "none"               — no recognized pattern (default; pair with effect != none
                         for nav/download/etc. controls).
- "opens-menu"         — dropdown / listbox / popup menu appears (filter
                         dropdowns, select-style controls, kebab menus,
                         autocomplete popovers, DOM <dialog>). aria-haspopup
                         is the strongest signal.
- "switches-tab"       — clicking changes which content panel is visible
                         (role="tab", tab-strip buttons).
- "toggles-expansion"  — accordion / disclosure widget. The button carries
                         aria-expanded; a section expands or collapses inline.
- "toggles-state"      — checkbox / radio / switch flips a binary state.
- "submits-in-place"   — form submit that updates the page without navigation
                         (search form whose results render in-page).
- "mutates-page"       — catch-all for "something visible changes but doesn't
                         fit a more specific pattern." Use sparingly.

Tie-breakers:
- A chevron / caret next to the element strongly suggests "opens-menu" or
  "toggles-expansion."
- A label containing value-text ("All images ▼") is almost certainly
  interactionPattern = "opens-menu", effect = "none".
- "Sign out" / "Delete" buttons often trigger confirmation dialogs — that's
  effect = { kind: "triggers-modal", modalKind: "confirm" } when the dialog is
  a browser confirm(), or interactionPattern = "opens-menu" when it's a DOM
  overlay. Use the DOM evidence to decide.

CONFIDENCE:
- 0-1, self-reported. Reflects how sure you are the selector AND profile are right.
- High when you have strong stable attributes (data-test-id, aria-label).
- Lower when you had to use class-prefix matching on multi-class hashed elements.
- Very low when the selector relies on positional or structural cues.

RATIONALE:
- One short sentence explaining the selector choice and confidence level.
- For the author's log entry; not shown in the UI by default.`;

    // v2.74.298 — Ambiguity signal. When the picker selector matches
    // more than one element on the live DOM, lead the user message
    // with that fact so Claude knows it's in scenario (ii) — needs
    // to disambiguate via visual reasoning. The screenshot's red
    // rectangle marks the intended target among the matches.
    const ambigueLine = (matchedCount != null && matchedCount > 1)
      ? `⚠ AMBIGUOUS PICKER SELECTOR — matches ${matchedCount} elements on the page; the highlighted region in the screenshot is the ONE intended target. Propose a selector that uniquely identifies that highlighted element among the ${matchedCount} matches.`
      : '';
    const userText = [
      ambigueLine,
      ambigueLine ? '' : null,
      `Role (author's stated intent): ${role || '(none)'}`,
      `Picker's raw selector: ${currentSelector}`,
      matchedCount != null ? `Matched elements on live DOM: ${matchedCount}${matchedCount === 1 ? ' (unique)' : ' (AMBIGUOUS — see above)'}` : '',
      `Frame: ${frame}`,
      '',
      'Rule-derived capabilities + element shape:',
      JSON.stringify({
        tag        : fingerprint?.tag,
        inputType  : fingerprint?.inputType,
        ariaRole   : fingerprint?.ariaRole,
        ariaLabel  : fingerprint?.ariaLabel,
        capabilities: fingerprint?.capabilities,
      }, null, 2),
      '',
      `Allowed operations (rule-derived — operationsCommon must be a subset): ${operationsAllowed.join(', ')}`,
      '',
      'Matched element outerHTML:',
      outerHTMLPreview,
      '',
      parentOuterHTMLPreview ? 'Parent element outerHTML (sibling context):' : '',
      parentOuterHTMLPreview,
    ].filter(Boolean).join('\n');

    // v2.74.291 — Diagnostic logging. Pre-fix the image content block
    // was assembled silently — if Claude reported it never saw a
    // screenshot there was no signal in Logs as to whether the bytes
    // reached this method or were stripped by the message-passing hop.
    // We now log three separable states:
    //   - screenshotDataUrl absent at entry (helper returned null / sidepanel didn't pass it)
    //   - screenshotDataUrl present but regex didn't match (malformed data URL)
    //   - imageContent assembled (success — image goes to Claude)
    let imageContent = null;
    const screenshotEntryState = !screenshotDataUrl
      ? 'absent'
      : (typeof screenshotDataUrl !== 'string'
          ? `wrong-type (${typeof screenshotDataUrl})`
          : `present (${screenshotDataUrl.length} chars)`);
    if (screenshotDataUrl && typeof screenshotDataUrl === 'string') {
      const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(screenshotDataUrl);
      if (m) {
        imageContent = {
          type: 'image',
          source: { type: 'base64', media_type: m[1], data: m[2] },
        };
      } else {
        Logger.warn('AnthropicService', `generateLandmarkProfile: screenshotDataUrl present but didn't match data:image/<type>;base64,<...> regex — first 80 chars: "${screenshotDataUrl.slice(0, 80)}"`);
      }
    }

    Logger.info('AnthropicService', `generateLandmarkProfile — role="${role}" selector="${(currentSelector || '').slice(0, 80)}" screenshotEntry=${screenshotEntryState} imageContentAssembled=${!!imageContent}`);

    const userContent = imageContent
      ? [imageContent, { type: 'text', text: userText }]
      : [{ type: 'text', text: userText }];

    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 1200, [], { role: 'describe', operation: 'generateLandmarkProfile' });
      if (!raw?.success) {
        Logger.warn('AnthropicService', `generateLandmarkProfile failed: ${raw?.error}`);
        return { success: false, profile: null, error: raw?.error ?? 'unknown' };
      }
      // Parse JSON. Defensive against Claude adding fences or preamble.
      let text = String(raw.text ?? '').trim();
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      // If Claude prefaced with text, grab from the first { to the last }.
      const firstBrace = text.indexOf('{');
      const lastBrace  = text.lastIndexOf('}');
      if (firstBrace > 0) text = text.slice(firstBrace);
      if (lastBrace > 0 && lastBrace < text.length - 1) text = text.slice(0, lastBrace + 1);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        Logger.warn('AnthropicService', `generateLandmarkProfile: JSON parse failed: ${e.message}; raw=${text.slice(0, 200)}`);
        return { success: false, profile: null, error: `JSON parse failed: ${e.message}` };
      }
      // Sanitize / clamp fields. Each is best-effort; missing fields
      // get sensible defaults so downstream code doesn't have to
      // null-check every value.
      // v2.74.287 — Reject Playwright / Cypress / jQuery pseudo-classes
      // and fall back to the picker's raw selector (always pure CSS).
      // Without this guard, Claude occasionally emits `:text-is(...)`,
      // `:has-text(...)`, or `text=...` which throw SyntaxError when
      // INSPECT_ELEMENT calls document.querySelectorAll. The fallback
      // path also surfaces the rejection as a pitfall so the author
      // can see the model wanted to discriminate by visible text and
      // a stronger structural selector wasn't found.
      let rawSelector       = typeof parsed.selector === 'string' ? parsed.selector.trim() : '';
      let selectorRejected  = false;
      if (rawSelector && _looksLikePlaywrightSelector(rawSelector)) {
        Logger.warn('AnthropicService', `generateLandmarkProfile: rejecting Playwright-style selector "${rawSelector.slice(0, 120)}" — falling back to picker selector`);
        rawSelector      = (currentSelector || '').trim();
        selectorRejected = true;
      }
      const profile = {
        selector        : rawSelector,
        description     : typeof parsed.description === 'string' ? parsed.description.trim().slice(0, 400) : '',
        aliases         : Array.isArray(parsed.aliases)
                            ? parsed.aliases
                                .filter(a => typeof a === 'string' && a.trim())
                                .map(a => a.trim().toLowerCase().slice(0, 60))
                                .slice(0, 5)
                            : [],
        operationsCommon: Array.isArray(parsed.operationsCommon)
                            ? parsed.operationsCommon
                                .filter(o => typeof o === 'string' && o.trim())
                                .map(o => o.trim())
                                .slice(0, 6)
                            : [],
        pitfalls        : Array.isArray(parsed.pitfalls)
                            ? parsed.pitfalls
                                .filter(p => typeof p === 'string' && p.trim())
                                .map(p => p.trim().slice(0, 280))
                                .slice(0, 6)
                            : [],
        expectedContent : parsed.expectedContent && typeof parsed.expectedContent === 'object'
                            ? {
                                kind   : typeof parsed.expectedContent.kind === 'string' ? parsed.expectedContent.kind : null,
                                format : typeof parsed.expectedContent.format === 'string' ? parsed.expectedContent.format : null,
                                example: typeof parsed.expectedContent.example === 'string' ? parsed.expectedContent.example.slice(0, 120) : null,
                              }
                            : null,
        // v2.74.305 — Spec-aligned: effect is a structured object,
        // interactionPattern is a separate string vocabulary. Both
        // clamped strictly; out-of-vocab values normalize to safe
        // defaults so a Claude typo can't pollute downstream.
        effect          : (() => {
          const EFFECT_KINDS = new Set([
            'none',
            'opens-new-thread', 'triggers-navigation',
            'triggers-modal', 'triggers-download',
          ]);
          const FORMS = new Set(['tab', 'window', 'popup', 'sidebar']);
          const MODAL_KINDS = new Set(['alert', 'confirm', 'prompt']);
          const raw = parsed.effect;
          if (!raw || typeof raw !== 'object') return { kind: 'none' };
          const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : '';
          if (!EFFECT_KINDS.has(kind)) return { kind: 'none' };
          if (kind === 'opens-new-thread') {
            const form = typeof raw.form === 'string' ? raw.form.trim().toLowerCase() : 'tab';
            return { kind, form: FORMS.has(form) ? form : 'tab' };
          }
          if (kind === 'triggers-modal') {
            const modalKind = typeof raw.modalKind === 'string' ? raw.modalKind.trim().toLowerCase() : 'confirm';
            return { kind, modalKind: MODAL_KINDS.has(modalKind) ? modalKind : 'confirm' };
          }
          return { kind };
        })(),
        interactionPattern: (() => {
          const PATTERN_VOCAB = new Set([
            'none',
            'opens-menu', 'switches-tab', 'toggles-expansion',
            'toggles-state', 'submits-in-place', 'mutates-page',
          ]);
          const v = typeof parsed.interactionPattern === 'string'
            ? parsed.interactionPattern.trim().toLowerCase()
            : 'none';
          return PATTERN_VOCAB.has(v) ? v : 'none';
        })(),
        confidence      : typeof parsed.confidence === 'number'
                            ? Math.max(0, Math.min(1, parsed.confidence))
                            : null,
        rationale       : typeof parsed.rationale === 'string' ? parsed.rationale.trim().slice(0, 280) : '',
      };
      // v2.74.287 — Surface the rejection as a pitfall + adjust the
      // rationale + clamp confidence so the author sees what happened.
      // We DON'T fail the call — falling back to the picker's selector
      // is strictly safer than refusing to author the landmark.
      if (selectorRejected) {
        const note = 'Claude proposed a Playwright-style text pseudo (e.g. :text-is) which is not valid CSS — fell back to the picker\'s structural selector. Consider tightening the picker selector by hand if it\'s ambiguous.';
        profile.pitfalls = [note, ...profile.pitfalls].slice(0, 6);
        if (typeof profile.confidence === 'number') {
          profile.confidence = Math.min(profile.confidence, 0.4);
        }
      }
      if (!profile.selector) {
        return { success: false, profile: null, error: selectorRejected
          ? 'Claude proposed an invalid CSS selector and no picker selector was provided as fallback'
          : 'no selector in returned profile' };
      }
      return { success: true, profile, error: null, usage: raw.usage };
    } catch (err) {
      Logger.warn('AnthropicService', `generateLandmarkProfile error: ${err.message}`);
      return { success: false, profile: null, error: err.message };
    }
  }

  static async generateConversationTitle(firstMessage) {
    if (!firstMessage || typeof firstMessage !== 'string') return null;
    const trimmed = firstMessage.trim().slice(0, 500);
    if (!trimmed) return null;

    const systemPrompt =
      'Generate a short conversation title of 4-6 words that summarizes the user\'s message. ' +
      'No punctuation, no quotation marks, no prefix like "Title:". Return only the title text itself.';
    const userContent = [{ type: 'text', text: `Message: ${trimmed}` }];

    Logger.info('AnthropicService', `generateConversationTitle — "${trimmed.slice(0, 60)}"`);

    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 40);
      if (!raw?.success) {
        Logger.warn('AnthropicService', `generateConversationTitle failed: ${raw?.error}`);
        return null;
      }
      const title = String(raw.text ?? '')
        .trim()
        .replace(/^["']+|["']+$/g, '')
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 60);
      return title || null;
    } catch (e) {
      Logger.warn('AnthropicService', `generateConversationTitle error: ${e.message}`);
      return null;
    }
  }

  /**
   * Pass B — Propose pre/post conditions for a Fragment based on its authoring
   * walk. Called after the user clicks Done on a Fragment walk.
   *
   * Inputs:
   *   - name, description: what the user said this Fragment does
   *   - startDom, endDom:  DOM snapshots at walk start and end
   *   - actions:           the DOM action sequence that transformed start→end
   *   - startUrl, endUrl:  URLs at start and end (may differ on navigation)
   *
   * Returns an object with `preconditions` and `postconditions` — each an
   * array of conditions using the same grammar as generateDetectConditions.
   *
   * Condition types:
   *   { type: 'selector_present', selector: '...' }
   *   { type: 'selector_absent',  selector: '...' }
   *   { type: 'url_matches',      pattern: '...' }
   *   { type: 'text_present',     text: '...' }
   *
   * The conditions are meant to be AND-ed: preconditions ALL hold before
   * execution is safe; postconditions ALL hold after to consider the
   * Fragment's effect successful.
   *
   * Returns { preconditions: [...], postconditions: [...], rationale: string }
   * or { preconditions: [], postconditions: [], error: string } on failure.
   */
  static async proposeFragmentConditions({
    name, description,
    startDom, endDom,
    actions = [],
    startUrl = '', endUrl = '',
  }) {
    if (!startDom || !endDom) {
      return { preconditions: [], postconditions: [], error: 'Missing DOM snapshots' };
    }

    const actionsSummary = actions.length === 0
      ? '(none recorded)'
      : actions.map((a, i) => `${i + 1}. ${a.action} ${a.selector ?? ''}${a.value ? ` = ${String(a.value).slice(0, 40)}` : ''}`).join('\n');

    const systemPrompt = `You infer pre/post conditions for a reusable web automation Fragment.

A Fragment is a deterministic sequence of DOM actions that transforms page state from A to B. Its preconditions describe state A (when it's safe to run). Its postconditions describe state B (how to verify it succeeded). Conditions must be checkable from the DOM alone without running the Fragment.

FRAGMENT: ${name}
DESCRIPTION: ${description}

CONDITION GRAMMAR — return arrays of these:
  { "type": "selector_present", "selector": "..." }   — CSS selector matches ≥1 element
  { "type": "selector_absent",  "selector": "..." }   — CSS selector matches 0 elements
  { "type": "url_matches",      "pattern": "..." }    — location.href matches a regex
  { "type": "text_present",     "text": "..." }       — case-insensitive substring in body text

RULES:
- Prefer robust selectors: data-test-*, data-testid, role, aria-label, semantic HTML. AVOID: nth-child, deeply nested paths, style-based classes.
- Propose 2–4 preconditions and 2–4 postconditions. Too many is fragile; too few is weak.
- Preconditions should identify the page/state where this Fragment makes sense to run.
- Postconditions should prove the Fragment's effect succeeded — the user "sees" the new state.
- Do NOT fabricate selectors. Only reference elements actually present in the DOM snapshots.
- If URLs differ from start to end, url_matches is often a strong postcondition.
- If you cannot confidently pick a condition, output fewer — empty arrays are OK.

RESPOND WITH JSON ONLY — no code fences, no prose:
{
  "preconditions":  [ {...}, ... ],
  "postconditions": [ {...}, ... ],
  "rationale": "one sentence explaining your choices"
}`;

    const userContent = `START URL: ${startUrl}
END URL:   ${endUrl}

START DOM snapshot:
${String(startDom).slice(0, 8000)}

END DOM snapshot:
${String(endDom).slice(0, 8000)}

DOM ACTIONS performed:
${actionsSummary}

Propose pre/post conditions as JSON.`;

    Logger.info('AnthropicService', `proposeFragmentConditions — "${name}" (${actions.length} actions)`);

    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 1200);
      if (!raw?.success) {
        return { preconditions: [], postconditions: [], error: raw?.error ?? 'LLM call failed' };
      }
      let text = String(raw.text ?? '').trim();
      const firstBrace = text.indexOf('{');
      const lastBrace  = text.lastIndexOf('}');
      if (firstBrace < 0 || lastBrace < firstBrace) {
        return { preconditions: [], postconditions: [], error: 'No JSON object in response' };
      }
      text = text.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(text);

      // Validate and coerce
      const pre  = Array.isArray(parsed.preconditions)  ? parsed.preconditions.filter(AnthropicService.#isValidCondition)  : [];
      const post = Array.isArray(parsed.postconditions) ? parsed.postconditions.filter(AnthropicService.#isValidCondition) : [];

      return {
        preconditions: pre,
        postconditions: post,
        rationale: String(parsed.rationale ?? ''),
      };
    } catch (e) {
      Logger.warn('AnthropicService', `proposeFragmentConditions error: ${e.message}`);
      return { preconditions: [], postconditions: [], error: e.message };
    }
  }

  /** @private */
  static #isValidCondition(c) {
    if (!c || typeof c !== 'object') return false;
    switch (c.type) {
      case 'selector_present':
      case 'selector_absent':
        return typeof c.selector === 'string';
      case 'url_matches':
        return typeof c.pattern === 'string';
      case 'text_present':
        return typeof c.text === 'string';
      default:
        return false;
    }
  }

  /**
   * v2.72.28 (Pass 16) — Compose a Assertion body from a typed contract.
   *
   * Assertions are vocabulary (saved condition expressions referenced from
   * primitive contracts), not primitives. This method authors a Assertion
   * body — a {match, conditions} envelope — using the existing condition
   * vocabulary, constrained to the requested family.
   *
   * Two callers:
   *   - Pass 16: the Studio Assertion form's "Generate" button. User
   *     authors a name + description, picks a family, clicks Generate.
   *     The proposed body is shown for review before save.
   *   - Pass 17+: the T3 strategy composer, when it determines a complex
   *     condition expression should be a named library Assertion rather
   *     than inlined. Same function, programmatic invocation.
   *
   * After successful generation the Assertion is saved as a regular T1
   * artifact (no runtime model invocation per evaluation). The
   * `authoredBy: 'model'` flag on the saved record is diagnostic only.
   *
   * @param {Object} contract
   * @param {string} contract.name         — short identifier
   * @param {string} contract.description  — what the assertion asserts
   * @param {'page'|'scope'|'mixed'} contract.family — vocabulary scope
   *
   * @param {Object} [context]
   * @param {string} [context.groundUrl]   — for page-family hints
   * @param {Object} [context.sampleScope] — sample bindings for scope-family
   *                                         (helps the model choose right fields)
   *
   * @returns {Promise<{ok: true, body: {match, conditions}} | {ok: false, error: string}>}
   */
  static async composeAssertion(contract, context = {}) {
    const name = String(contract?.name ?? '').trim();
    const description = String(contract?.description ?? '').trim();
    const family = (contract?.family === 'page' || contract?.family === 'scope' || contract?.family === 'mixed')
      ? contract.family : 'mixed';

    if (!description) {
      return { ok: false, error: 'composeAssertion requires a non-empty description' };
    }

    // Build the allowed-types list from the vocabulary, filtered by family.
    // 'mixed' = both page and scope families allowed.
    const allowedFamilies = family === 'mixed' ? ['page', 'scope'] : [family];
    const allowedTypes = getTypesByFamily(allowedFamilies)
      .filter(t => t !== 'assertion_ref'); // Don't suggest references during generation
    if (allowedTypes.length === 0) {
      return { ok: false, error: `composeAssertion: no condition types available for family="${family}"` };
    }

    // Build a vocabulary description for the prompt: each type with its
    // required fields. Compact so the prompt stays small.
    const vocabularyHelp = allowedTypes.map(t => {
      const schema = CONDITION_FIELDS[t];
      const fields = (schema?.fields ?? []).map(f => `"${f}": "..."`).join(', ');
      const fam = schema?.family ?? '?';
      return `  { "type": "${t}", ${fields} }   [${fam}]`;
    }).join('\n');

    const systemPrompt = `You author a Assertion body — a saved condition expression referenced from primitive contracts.

A Assertion is **vocabulary**, not a primitive. It has no preconditions or postconditions of its own. It IS a condition expression: a {match, conditions} envelope evaluated as a single boolean against scope and page state at the point where it's referenced.

Your output:
  { "match": "all" | "any" | "k_of_n", "count"?: <int>, "conditions": [<condition>, ...] }

CONDITION VOCABULARY (family-restricted to: ${allowedFamilies.join(', ')}):
${vocabularyHelp}

RULES:
- Output JSON ONLY. No code fences. No prose.
- Use 2-5 conditions. Too many is fragile; too few is weak.
- "all" (AND) is most common. Use "any" (OR) only when the assertion is genuinely disjunctive. Use "k_of_n" (with explicit "count") when robust-against-page-variation matters.
- For page-family conditions, prefer robust selectors (data-testid, role, aria-label, semantic HTML). Avoid nth-child or deeply nested paths.
- For scope-family conditions, the binding name must reference a binding the assertion's caller will provide. The most common binding name is INPUT (for analyses). Match what the description implies.
- If the description doesn't clearly map to the vocabulary, output an empty conditions array — never fabricate types or fields.

ASSERTION NAME: ${name || '(unnamed)'}
DESCRIPTION: ${description}`;

    const userParts = [];
    if (context?.groundUrl) {
      userParts.push(`GROUND URL: ${context.groundUrl}`);
    }
    if (context?.sampleScope && typeof context.sampleScope === 'object') {
      const sample = JSON.stringify(context.sampleScope, null, 2).slice(0, 2000);
      userParts.push(`SAMPLE SCOPE (representative bindings the assertion may reference):\n${sample}`);
    }
    userParts.push('Author the assertion body as JSON.');
    const userContent = userParts.join('\n\n');

    Logger.info('AnthropicService', `composeAssertion — "${name}" (family=${family})`);

    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 1200);
      if (!raw?.success) {
        return { ok: false, error: raw?.error ?? 'LLM call failed' };
      }
      let text = String(raw.text ?? '').trim();
      const firstBrace = text.indexOf('{');
      const lastBrace  = text.lastIndexOf('}');
      if (firstBrace < 0 || lastBrace < firstBrace) {
        return { ok: false, error: 'No JSON object in response' };
      }
      text = text.slice(firstBrace, lastBrace + 1);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        return { ok: false, error: `JSON parse failed: ${e.message}` };
      }

      // Validate envelope shape.
      const match = (parsed.match === 'any' || parsed.match === 'k_of_n') ? parsed.match : 'all';
      const conds = Array.isArray(parsed.conditions) ? parsed.conditions : [];
      if (conds.length === 0) {
        return { ok: false, error: 'Model returned no conditions — try refining the description' };
      }

      // Validate each condition: type is in allowed set, required fields
      // present and non-empty. Fail-loud on any violation rather than
      // silently dropping bad conditions.
      const validatedConditions = [];
      for (const c of conds) {
        if (!c || typeof c !== 'object' || typeof c.type !== 'string') {
          return { ok: false, error: 'Condition is not an object with a string `type`' };
        }
        if (!allowedTypes.includes(c.type)) {
          return { ok: false, error: `Condition type "${c.type}" is not in the allowed vocabulary for family="${family}"` };
        }
        const schema = CONDITION_FIELDS[c.type];
        const required = schema?.fields ?? [];
        const out = { type: c.type };
        for (const f of required) {
          const v = c[f];
          if (v == null || (typeof v === 'string' && !v.trim())) {
            return { ok: false, error: `Condition "${c.type}" missing required field "${f}"` };
          }
          out[f] = typeof v === 'string' ? v : String(v);
        }
        validatedConditions.push(out);
      }

      const body = { match, conditions: validatedConditions };
      if (match === 'k_of_n') {
        const count = Number(parsed.count);
        if (!Number.isFinite(count) || count < 1 || count > validatedConditions.length) {
          return { ok: false, error: `k_of_n match requires a "count" between 1 and ${validatedConditions.length}` };
        }
        body.count = Math.floor(count);
      }

      return { ok: true, body };
    } catch (e) {
      Logger.warn('AnthropicService', `composeAssertion error: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  static async matchQuestionToGround({ question, groundProfiles }) {
    if (!groundProfiles?.length) return [];

    // Exclude sampleExchanges — raw DOM-extracted text that contains UI chrome
    // and noise. Routing is based on structured capability fields only.
    const profileSummaries = groundProfiles.map((g, i) => {
      const { sampleExchanges: _omit, ...clean } = g.profile ?? {};
      return `Ground ${i + 1} (id: ${g.groundId}, name: "${g.aiName}"):\n${JSON.stringify(clean, null, 2)}`;
    }).join('\n\n---\n\n');

    const systemPrompt = `You match a user question to the most capable AI assistant ground.

You are given a user question and ${groundProfiles.length} ground profile(s). Each profile
describes what an AI assistant can do — its domains, capabilities, data sources, and limitations.

Score each ground with a confidence value from 0.0 to 1.0:
  1.0 — Perfect match: the ground explicitly handles this type of question
  0.7 — Strong match: the ground's domain covers this question
  0.4 — Partial match: tangentially related but not the primary use case
  0.1 — Weak match: possible but unlikely
  0.0 — No match: outside this ground's scope entirely

Return a JSON array with one object per ground, sorted by confidence descending:
[{ "groundId": "...", "confidence": 0.9, "reason": "one sentence" }, ...]

Return ONLY the JSON array. No explanation, no markdown.`;

    const userContent = [{
      type: 'text',
      text: `User question: "${question}"\n\nGround profiles:\n\n${profileSummaries}\n\nRank the grounds by confidence.`,
    }];

    Logger.info('AnthropicService', `matchQuestionToGround — "${question.slice(0, 60)}" against ${groundProfiles.length} ground(s)`);

    // v2.74.796 — maxTokens 2048 (was 512). This returns ONE object per Ground; with a real library (the live
    // trace had 31 Grounds) the array overran 512 tokens and truncated mid-string → "Unterminated string in JSON"
    // parse error, dropping the whole ranking. 2048 fits ~40–50 ranked Grounds with margin.
    const raw = await AnthropicService.#call(systemPrompt, userContent, 2048, [
      { role: 'assistant', content: '[' },
    ]);

    if (!raw.success) {
      Logger.warn('AnthropicService', `matchQuestionToGround failed: ${raw.error}`);
      return [];
    }

    try {
      const cleaned = AnthropicService.#stripFences('[' + raw.text);
      const parsed  = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) throw new Error('Not an array');

      // Merge aiName back in from groundProfiles (not sent in matching result)
      const nameMap = Object.fromEntries(groundProfiles.map(g => [g.groundId, g.aiName]));
      const ranked  = parsed
        .filter(r => r.groundId && typeof r.confidence === 'number')
        .map(r => ({ ...r, aiName: nameMap[r.groundId] ?? r.groundId }))
        .sort((a, b) => b.confidence - a.confidence);

      Logger.info('AnthropicService', `Matching result:`, ranked.map(r => `${r.aiName}:${r.confidence}`));
      return ranked;
    } catch (e) {
      Logger.warn('AnthropicService', `matchQuestionToGround parse error: ${e.message}`);
      return [];
    }
  }

  // ── Prompt registry ───────────────────────────────────────────────────────

  /**
   * Returns a registry of all built-in system prompts used by the extension.
   * Used by the Prompts tab in the side panel to display, label, and describe
   * each prompt for transparency and debugging.
   *
   * @returns {Array<{ id: string, label: string, description: string, prompt: string }>}
   */
  static getPromptRegistry() {
    return [
      {
        id          : 'get_next_step',
        label       : 'Walk — Get Next Step',
        description : 'Sent each turn during ground discovery. Given the current DOM summary and confirmed step history, asks Claude for the single next browser action to take toward opening the AI panel, typing the sample question, submitting it, and extracting the response.',
        prompt      : `You are a browser automation engineer doing a live step-by-step walk of an AI product UI.

You are given an interactive DOM summary of the CURRENT browser state, plus the confirmed step history.

Your job: return the SINGLE NEXT step to progress toward:
  → locating the AI assistant chat input (it may be inside a panel that just opened)
  → typing the discovery question into it
  → submitting it
  → waiting for and extracting the AI response

## Step schema

Return a JSON object with exactly these fields:

| Field      | Type   | Value                                                        |
|------------|--------|--------------------------------------------------------------|
| step       | number | Current turn number                                          |
| action     | string | NAVIGATE, CLICK, TYPE, WAIT, WAIT_FOR, FIND_AI, or EXTRACT  |
| selector   | string | CSS selector; empty only for NAVIGATE and WAIT              |
| value      | string | See action rules below                                       |

Action rules:
- NAVIGATE — value: full URL string
- CLICK    — value: ""
- TYPE     — value: MUST be exactly the dynamically generated sample question
- WAIT     — selector: "", value: milliseconds as string
- WAIT_FOR — value: timeout milliseconds as string
- EXTRACT  — value: ""

${SELECTOR_RULES}

${TIMING_RULES}`,
      },
      {
        id          : 'generate_sample_question',
        label       : 'Walk — Generate Sample Question',
        description : 'Called once at walk start before the first turn. Generates a single natural, contextually appropriate question tailored to the specific AI product and URL. This question is typed into the AI during discovery so it responds naturally. It is replaced with {{USER_QUESTION}} when the template is saved.',
        prompt      : `You generate a single, natural test question for an AI assistant product.

The question will be typed into the AI's chat interface during automated browser testing.
It must be:
- Specific enough that the AI gives a substantive response (not a one-word answer)
- Generic enough that it works without any prior context or user data
- Appropriate for the product's domain (inferred from the product name and URL)
- A single sentence, no longer than 15 words
- Natural conversational English — not a test query, not meta

Return ONLY the question text. No quotes, no explanation, no punctuation other than the question mark.`,
      },
      {
        id          : 'discover_anchors',
        label       : 'Walk — Discover Semantic Anchors',
        description : 'Called once after the send CLICK is confirmed. Analyses the panel DOM to identify two product-agnostic validation anchors: (1) sendBusy — the element visible while the AI is generating a response, (2) responseContainer — the element type containing AI response messages. These anchors are saved with the template and used by all three validation layers at test runtime.',
        prompt      : `You are analysing the DOM of an AI assistant chat panel to identify two semantic anchors.

You will return a JSON object with exactly two fields:

  "sendBusy"          — CSS selector for the element that shows the AI is currently
                        processing/generating a response. Look for:
                        - A send/submit button with aria-disabled="true" or disabled attribute
                        - A loading spinner or progress indicator
                        - Any element whose state changes while the AI is responding
                        Return null if no such element is visible in this DOM.

  "responseContainer" — CSS selector for the element type that contains AI response
                        messages in the chat thread. Look for:
                        - Elements with data-testid containing "message", "response", "chat"
                        - Elements with role="article" or role="log"
                        - Repeating container elements that hold message text
                        Return null if no such element is identifiable.

RULES:
- Return ONLY the JSON object. No explanation, no markdown.
- Prefer data-testid and aria-label selectors over class names.
- The selector must be specific enough to uniquely identify the element type.
- If uncertain, return null rather than guessing.`,
      },
      {
        id          : 'generate_profile_questions',
        label       : 'Profiling — Generate Capability Questions',
        description : 'Called once after discovery completes. Generates N introspective meta-questions about the AI\'s own capabilities, data sources, and scope. These questions are submitted to the AI sequentially in the profiling pass to build a structured capability profile used for semantic question routing.',
        prompt      : `You generate introspective meta-questions for an AI assistant product.

These questions will be submitted directly to the AI during an automated profiling session.
Their purpose is to build a semantic capability map — understanding what the AI knows about
itself, what it can do, and what its boundaries are.

The questions must be INTROSPECTIVE — asking the AI about its own capabilities, not asking
it to perform a task.

GOOD examples:
- "What types of questions are you best equipped to answer?"
- "What data or records do you have direct access to?"
- "What business functions or departments are you primarily designed to support?"
- "What kinds of tasks are outside your current capabilities?"

BAD examples (do NOT generate):
- "How do I improve my B2B campaign?"
- "Find contacts in the healthcare industry"`,
      },
      {
        id          : 'match_question_to_ground',
        label       : 'Runtime — Match Question to Ground',
        description : 'Called when a user submits a question via the chat interface. Compares the question against all ground capability profiles and returns grounds ranked by confidence (0.0–1.0) with a one-sentence reason each. The top-ranked ground is selected for execution.',
        prompt      : `You match a user question to the most capable AI assistant ground.

You are given a user question and one or more ground profiles. Each profile describes what
an AI assistant can do — its domains, capabilities, data sources, and limitations.

Score each ground with a confidence value from 0.0 to 1.0:
  1.0 — Perfect match: the ground explicitly handles this type of question
  0.7 — Strong match: the ground's domain covers this question
  0.4 — Partial match: tangentially related but not the primary use case
  0.1 — Weak match: possible but unlikely
  0.0 — No match: outside this ground's scope entirely

Return a JSON array with one object per ground, sorted by confidence descending:
[{ "groundId": "...", "confidence": 0.9, "reason": "one sentence" }, ...]

Return ONLY the JSON array. No explanation, no markdown.`,
      },
      {
        id          : 'generate_template_oneshot',
        label       : 'Legacy — One-Shot Template Generation',
        description : 'Legacy prompt used for manual template generation from a static DOM snapshot. Generates the complete step array in a single API call rather than the iterative walk approach. Still available as a fallback for manual template authoring.',
        prompt      : `You are a senior browser automation engineer with deep expertise in testing AI agent products.

Your task is to generate a JSON step array that locates the AI assistant chat interface,
submits a test question, waits for the response, and extracts it.

${SCHEMA_RULES()}

${SELECTOR_RULES}

${TIMING_RULES}

Return ONLY the raw JSON array. No fences, no explanation.
{{USER_QUESTION}} for TYPE value. Sequential step numbers starting at 1.`,
      },
    ];
  }

  /**
   * Analyses a DOM snapshot to discover three semantic anchors for a chat panel:
   *
   *   generationIndicator — selector for any element visible ONLY while the AI
   *                         is generating. Disappears when generation completes.
   *                         This is the primary completion gate.
   *
   *   responseContainer   — selector for the repeating element type that holds
   *                         each message in the thread. Used for baseline counting.
   *
   *   responseElement     — selector for the specific element holding the AI's
   *                         response text. Used for final text extraction.
   *
   * @param {Object}  options
   * @param {string}  options.aiName
   * @param {string}  options.dom          - DOM snapshot of the panel frame.
   * @param {boolean} [options.expectBusy=true] - True when snapshot is mid-generation.
   * @returns {Promise<{ generationIndicator: string|null, responseContainer: string|null, responseElement: string|null }>}
   */
  static async discoverAnchors({ aiName, dom, expectBusy = true }) {
    const systemPrompt = `You are analysing the DOM of an AI assistant chat panel to identify three semantic anchors.

Return a JSON object with exactly three fields:

"generationIndicator" — CSS selector for ANY element present ONLY while the AI is generating
  a response and disappears (or is replaced) when generation is complete.

  The DOM snapshot includes these attributes:
    new="true"      — element appeared after the question was sent
    changed="true"  — element's text changed this turn
    text="..."      — actual visible text content

  Look for these patterns:
  - An element with new="true" showing short status text like "Just a moment", "Gathering context",
    "Thinking...", "Analyzing..." — these are TEXT-BASED generation indicators. Many modern AI
    assistants use descriptive text instead of visual spinners. THESE ARE THE MOST COMMON PATTERN.
  - data-testid containing "reasoning", "animation", "thinking", "loading", "spinner", "stop"
  - A stop-generation button (new="true", data-testid containing "stop")
  - Any element with aria-busy="true"
  - changed="true" on an element with short status-like text

  CRITICAL: If you see an element with new="true" AND text="Just a moment" or similar short
  status phrases, that IS the generationIndicator — return its data-testid selector.
  Return null only if no such element exists in the snapshot.

"responseContainer" — CSS selector for the repeating wrapper element for each message.
  Look for: data-testid containing "message", "container", "chat", "turn", "response".
  Return null if not identifiable.

"responseElement" — CSS selector for the element containing the AI's actual response text.
  Use new="true" and text="..." to identify it:
  1. Find elements with new="true" and substantial text content (not short status phrases)
  2. Verify the text is the AI's answer, not the user's question
  3. Prefer data-testid selectors
  4. Do NOT pick containers wrapping both user and AI messages
  Return null if not identifiable with confidence.

${expectBusy
  ? 'DOM captured DURING generation. The generationIndicator MUST be present — find it. Look specifically for elements with new="true" and short status text.'
  : 'DOM captured AFTER generation. No generationIndicator expected. Focus on responseElement using new="true" and text="..." to identify the AI response.'}

Return ONLY the JSON object. No explanation, no markdown.
Prefer data-testid selectors. Avoid class names and framework-scoped attributes (data-v-*).

Example: {"generationIndicator":"[data-test-id='assistant-reasoning-animation']","responseContainer":"[data-test-id='chat-container']","responseElement":"[data-test-id='chat-message']"}`;

    const userContent = [{
      type: 'text',
      text: `Product: ${aiName}\n\nPanel DOM snapshot:\n${dom}\n\nIdentify the three anchors.`,
    }];

    Logger.info('AnthropicService', `discoverAnchors — expectBusy:${expectBusy} dom:${dom.length}chars`);

    const raw = await AnthropicService.#call(systemPrompt, userContent, 256, [
      { role: 'assistant', content: '{"generationIndicator":' },
    ]);

    if (!raw.success) {
      Logger.warn('AnthropicService', `discoverAnchors API call failed: ${raw.error}`);
      return { generationIndicator: null, responseContainer: null, responseElement: null };
    }

    try {
      const cleaned = AnthropicService.#stripFences('{"generationIndicator":' + raw.text);
      const parsed  = JSON.parse(cleaned);
      const result  = {
        generationIndicator : parsed.generationIndicator ?? null,
        responseContainer   : parsed.responseContainer   ?? null,
        responseElement     : parsed.responseElement     ?? null,
      };
      Logger.info('AnthropicService', `discoverAnchors result`, result);
      return result;
    } catch (e) {
      Logger.warn('AnthropicService', `discoverAnchors parse error: ${e.message}`);
      return { generationIndicator: null, responseContainer: null, responseElement: null };
    }
  }

  // ── Response completion detection ─────────────────────────────────────────

  /**
   * Asks Claude whether the AI response is complete given the current panel DOM.
   * Replaces the text-stability polling heuristic — Claude reads the DOM directly
   * and determines whether the response is still streaming or has finished.
   *
   * Returns { complete: boolean, reason: string }.
   * Falls back to { complete: true } on API failure so extraction proceeds.
   *
   * @param {Object} options
   * @param {string} options.aiName
   * @param {string} options.dom       - Current panel frame DOM snapshot.
   * @param {string} options.responseContainer - Selector for response elements.
   * @returns {Promise<{ complete: boolean, reason: string }>}
   */
  static async isResponseComplete({ aiName, dom, responseContainer }) {
    const systemPrompt = `You are analysing the DOM of an AI assistant chat panel to determine if the AI has finished responding.

Look at the response container elements (${responseContainer || 'message elements'}) and determine:
- Is there a loading indicator, spinner, or streaming cursor visible?
- Does the last message element appear complete (ends with punctuation, has reasonable length)?
- Is the send button re-enabled (not aria-disabled)?

Return a JSON object: { "complete": true/false, "reason": "one sentence" }
Return ONLY the JSON object.`;

    const userContent = [{
      type: 'text',
      text: `AI: ${aiName}\n\nPanel DOM:\n${dom}\n\nHas the AI finished responding?`,
    }];

    const raw = await AnthropicService.#call(systemPrompt, userContent, 128, [
      { role: 'assistant', content: '{"complete":' },
    ]);

    if (!raw.success) {
      Logger.warn('AnthropicService', `isResponseComplete failed — assuming complete`);
      return { complete: true, reason: 'API call failed — proceeding' };
    }

    try {
      const parsed = JSON.parse(AnthropicService.#stripFences('{"complete":' + raw.text));
      Logger.debug('AnthropicService', `isResponseComplete: ${parsed.complete} — ${parsed.reason}`);
      return { complete: !!parsed.complete, reason: parsed.reason ?? '' };
    } catch {
      return { complete: true, reason: 'Parse failed — proceeding' };
    }
  }

  // ── Legacy one-shot template generation ──────────────────────────────────

  /**
   * One-shot template generation from a static DOM snapshot.
   * Still used when the user manually pastes a template or triggers generation
   * outside the walk flow.
   *
   * @param {GenerateTemplateOptions} options
   * @returns {Promise<GenerateResult>}
   */
  static async generateTemplate(options) {
    const { groundUrl, aiName, domSnapshot, screenshot } = options;

    if (!(await AnthropicService.hasLlm())) return { success: false, rawJson: null, steps: null, error: 'No Anthropic API key set. Add it in Settings.' };

    const systemPrompt = `You are a senior browser automation engineer with deep expertise in testing AI agent products.

Your task is to generate a JSON step array that locates the AI assistant chat interface, submits a test question, waits for the response, and extracts it.

${SCHEMA_RULES()}
${SELECTOR_RULES}
${TIMING_RULES}

AI AGENT UI PATTERNS:
PATTERN A — Side panel/drawer: NAVIGATE → WAIT_FOR app shell → FIND_AI or CLICK trigger → WAIT_FOR chat input → CLICK → TYPE → submit → WAIT_FOR response → EXTRACT
PATTERN B — Inline chat (ChatGPT, Claude.ai): NAVIGATE → WAIT_FOR input → CLICK → TYPE → submit → WAIT_FOR response → EXTRACT

OUTPUT: Return ONLY the raw JSON array. No fences, no explanation. {{USER_QUESTION}} for TYPE value. Sequential step numbers starting at 1.`;

    const userContent = [];
    if (screenshot) {
      userContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } });
    }
    userContent.push({
      type: 'text',
      text: `Product: ${aiName}\nURL: ${groundUrl}\n\nIdentify the UI pattern from the screenshot and DOM, then generate the step array.\n\nDOM:\n\`\`\`html\n${domSnapshot.slice(0, 40000)}\n\`\`\`\n\nReturn only the JSON array.`,
    });

    Logger.info('AnthropicService', `generateTemplate — ${aiName}`);
    const raw = await AnthropicService.#call(systemPrompt, userContent, 4096);
    if (!raw.success) return { success: false, rawJson: null, steps: null, error: raw.error };

    const cleaned = AnthropicService.#stripFences(raw.text);
    const validation = SchemaValidator.validate(cleaned);
    if (!validation.valid) {
      Logger.warn('AnthropicService', `generateTemplate validation failed: ${validation.error}`);
      return { success: false, rawJson: cleaned, steps: null, error: `Claude returned invalid JSON: ${validation.error}` };
    }

    Logger.info('AnthropicService', `generateTemplate success — ${validation.steps.length} steps`);
    return { success: true, rawJson: cleaned, steps: validation.steps, error: null };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Shared Anthropic API call wrapper.
   *
   * @private
   * @param {string}   systemPrompt
   * @param {Object[]} userContent
   * @param {number}   maxTokens
   * @param {Object[]} [extraMessages=[]] - Additional messages appended after the user turn
   *                                        (used for assistant prefill).
   * @returns {Promise<{ success: boolean, text: string, error: string|null }>}
   */
  /**
   * v2.74.354 — Extract the FIRST complete JSON object from model text by
   * brace-matching from the first `{` (respecting string literals/escapes).
   * Robust to trailing prose, markdown fences, and braces in surrounding text
   * — unlike `slice(indexOf('{'), lastIndexOf('}'))`, which over-captures any
   * trailing `}` and makes JSON.parse throw "non-whitespace after JSON".
   * @param {string} text
   * @returns {string|null} the JSON substring, or null if none/unbalanced
   */
  static #firstJsonObject(text) {
    const s = String(text ?? '');
    const start = s.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
    }
    return null;   // unbalanced — truncated output
  }

  // ─── v2.74.358 — LLM-call audit (DESIGN_llm_roles.md § 4) ─────────────────
  // Every #call records a generic { role, operation, latency, ok } entry,
  // independent of whether the caller labeled a role — so audit coverage is
  // 100% from day one and un-labeled calls show as 'unclassified' (the
  // visible migration backlog). Writes are serialized through a promise chain
  // so concurrent calls don't clobber the capped ring. Best-effort; never
  // throws into the caller.
  static #auditChain = Promise.resolve();
  static #audit(entry) {
    AnthropicService.#auditChain = AnthropicService.#auditChain.then(async () => {
      try {
        const KEY = 'llm:audit';
        const got = await new Promise(r => chrome.storage.local.get(KEY, r));
        const list = Array.isArray(got?.[KEY]) ? got[KEY] : [];
        list.push(entry);
        while (list.length > 300) list.shift();
        await new Promise(r => chrome.storage.local.set({ [KEY]: list }, r));
      } catch { /* audit is best-effort */ }
    });
  }

  // `meta` (optional) = { role, operation } — the call's declared role
  // (DESIGN_llm_roles.md § 2). Absent → audited as 'unclassified'.
  static async #call(systemPrompt, userContent, maxTokens, extraMessages = [], meta = null) {
    const role = meta?.role ?? 'unclassified';
    const operation = meta?.operation ?? 'unknown';
    const hasVision = Array.isArray(userContent) && userContent.some(b => b?.type === 'image');
    const model = pickModelForCall(role, operation, hasVision);   // v2.74.360 — role→model policy
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const t0 = now();
    let _llm;
    try { _llm = await AnthropicService.#llmTransport(); }
    catch {
      AnthropicService.#audit({ ts: Date.now(), role, operation, latencyMs: 0, ok: false, outputChars: 0, inTokens: 0, outTokens: 0, costUsd: null, model, error: 'no-api-key' });
      return { success: false, text: '', error: 'No API key' };
    }

    const messages = [
      { role: 'user', content: userContent },
      ...extraMessages,
    ];

    try {
      const res = await fetch(_llm.url, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', ..._llm.headers },
        body: JSON.stringify({
          model,
          max_tokens : maxTokens,
          system     : systemPrompt,
          messages,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }

      const data = await res.json();
      const text = data?.content?.[0]?.text ?? '';
      if (!text) throw new Error('Empty response from Claude');

      // v2.74.154 — Expose token usage to callers so LLM observation
      // sites can log cost metadata. Keyed in camelCase (inputTokens /
      // outputTokens) to match the rest of the codebase; Anthropic's
      // API uses snake_case (input_tokens / output_tokens).
      const usage = {
        inputTokens : Number(data?.usage?.input_tokens  ?? 0),
        outputTokens: Number(data?.usage?.output_tokens ?? 0),
      };
      AnthropicService.#audit({ ts: Date.now(), role, operation, latencyMs: Math.round(now() - t0), ok: true, outputChars: text.length, inTokens: usage.inputTokens, outTokens: usage.outputTokens, costUsd: estimateCostUSD(model, usage)?.total ?? null, model });
      Logger.debug('AnthropicService', `API call success — ${text.length} chars [${role}/${operation}]`, usage);
      return { success: true, text, error: null, usage };

    } catch (err) {
      AnthropicService.#audit({ ts: Date.now(), role, operation, latencyMs: Math.round(now() - t0), ok: false, outputChars: 0, inTokens: 0, outTokens: 0, costUsd: null, model, error: String(err.message).slice(0, 120) });
      Logger.error('AnthropicService', `API call failed [${role}/${operation}]: ${err.message}`);
      return { success: false, text: '', error: err.message };
    }
  }

  /**
   * R-3 — the front-door ROUTER call (DESIGN_llm_front_door.md §3.1; DESIGN_injection_boundary.md §3). Builds
   * the fenced-catalog messages (NO live DOM is ever included), asks the model to select ONE tool + params
   * (or signal demonstrate / decompose), and parses the structured reply into the contract Core/route.js
   * consumes. PURE prompt + parse live in Core/routerPrompt.js; this is the thin transport.
   * @param {{ ask:string, tools:Array<object> }} args
   * @returns {Promise<{tool:(string|null),params:object,confidence:number,needs_decompose:boolean,needs_demonstration:boolean,subAsks:string[],reason:string}>}
   */
  static async routeAsk({ ask, tools } = {}) {
    const { system, user } = buildRouterMessages(ask, Array.isArray(tools) ? tools : []);
    // v1 uses the default policy model; R-6 (model tiering) routes operation 'route-ask' -> MODEL_FAST (Haiku).
    const res = await AnthropicService.#call(system, user, 1024, [], { role: 'routing', operation: 'route-ask' });
    if (!res || res.success === false) {
      return { ...parseRouterOutput(null), reason: 'router-unavailable' };   // fail safe; reason lets chat fall back
    }
    return parseRouterOutput(res.text);
  }

  /**
   * Strips markdown code fences from a response string.
   * @private
   * @param {string} text
   * @returns {string}
   */
  static #stripFences(text) {
    return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }

  /**
   * Extracts the first complete balanced JSON object from a string.
   * Handles: leading prose, trailing prose, code fences, prefill continuations.
   * @private
   * @param {string} text - Raw response text, may include non-JSON content.
   * @returns {string} The first {...} substring, or the original text if no braces found.
   */
  static #extractJson(text) {
    const start = text.indexOf('{');
    if (start === -1) return text;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape)          { escape = false; continue; }
      if (ch === '\\')     { escape = true;  continue; }
      if (ch === '"')      { inString = !inString; continue; }
      if (inString)        continue;
      if (ch === '{')      depth++;
      else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    return text.slice(start); // unclosed — best effort
  }

  // ── Prompts registry ──────────────────────────────────────────────────────

  /**
   * Returns the catalogue of all built-in system prompts used by Agent HUB.
   * Used by the Prompts tab in the side panel for inspection and transparency.
   *
   * @returns {Array<{ id: string, label: string, description: string, prompt: string }>}
   */
  static getPromptsRegistry() {
    return [
      {
        id          : 'walk_next_step',
        label       : 'Walk — Next Step',
        description : 'Instructs Claude to return the single next browser automation step during path discovery. Receives the current DOM summary and confirmed step history.',
        prompt      : `You are a browser automation engineer doing a live step-by-step walk of an AI product UI.

You are given an interactive DOM summary of the CURRENT browser state, plus the confirmed step history.

Your job: return the SINGLE NEXT step to progress toward:
  → locating the AI assistant chat input (it may be inside a panel that just opened)
  → typing the discovery question into it
  → submitting it
  → waiting for and extracting the AI response

## Step schema

Return a JSON object with exactly these fields:

| Field      | Type   | Value                                                        |
|------------|--------|--------------------------------------------------------------|
| step       | number | Current turn number                                          |
| action     | string | NAVIGATE, CLICK, TYPE, WAIT, WAIT_FOR, FIND_AI, or EXTRACT  |
| selector   | string | CSS selector; empty only for NAVIGATE and WAIT              |
| value      | string | See action rules below                                       |

Action rules:
- NAVIGATE — value: full URL string
- CLICK    — value: ""
- TYPE     — value: MUST be the generated sample question
- WAIT     — selector: "", value: milliseconds as string
- WAIT_FOR — value: timeout milliseconds as string
- EXTRACT  — value: ""

SELECTOR RULES:
- Provide 3–5 comma-separated fallback selectors, most-specific first.
- Prefer: data-testid, data-test-id, aria-label, role, placeholder attributes.
- Avoid: nth-child, generated class hashes, :has(), :last-child pseudo-classes.
- Never use :has-text() — not a valid CSS selector.

TIMING RULES:
- After NAVIGATE: WAIT_FOR a reliable landmark, timeout 10000.
- After any CLICK that opens a panel/modal/dropdown: WAIT_FOR the INPUT inside it, timeout 8000.
- After submitting a question: WAIT_FOR the response element, timeout 30000.

CRITICAL — OUTPUT FORMAT:
You MUST return ONLY a single raw JSON object. No words before it, no words after it.`,
      },
      {
        id          : 'sample_question',
        label       : 'Walk — Sample Question Generation',
        description : 'Generates a single natural, contextually appropriate question to use during walk discovery. Tailored to the AI product name and URL.',
        prompt      : `You generate a single, natural test question for an AI assistant product.

The question will be typed into the AI's chat interface during automated browser testing.
It must be:
- Specific enough that the AI gives a substantive response (not a one-word answer)
- Generic enough that it works without any prior context or user data
- Appropriate for the product's domain (inferred from the product name and URL)
- A single sentence, no longer than 15 words
- Natural conversational English — not a test query, not meta

Return ONLY the question text. No quotes, no explanation, no punctuation other than the question mark.`,
      },
      {
        id          : 'profile_questions',
        label       : 'Profiling — Capability Questions',
        description : 'Generates N introspective meta-questions submitted to the AI during profiling. Designed to map the AI\'s capabilities, data access, and boundaries for semantic matching.',
        prompt      : `You generate introspective meta-questions for an AI assistant product.

These questions will be submitted directly to the AI during an automated profiling session.
Their purpose is to build a semantic capability map — understanding what the AI knows about
itself, what it can do, and what its boundaries are.

The questions must be INTROSPECTIVE — asking the AI about its own capabilities, not asking
it to perform a task. The responses will be used to semantically match future user questions
to the right AI assistant.

GOOD examples (introspective, capability-mapping):
- "What types of questions are you best equipped to answer?"
- "What data or records do you have direct access to?"
- "What business functions or departments are you primarily designed to support?"
- "What kinds of tasks are outside your current capabilities?"
- "How would you describe your primary purpose to a new user?"

BAD examples (task-specific — do NOT generate these):
- "How do I improve my B2B campaign?"
- "Find contacts in the healthcare industry"
- "Summarise last quarter's pipeline"

Requirements:
- Each question is standalone and self-contained
- Phrased as if speaking directly to the AI ("What can you...", "How would you...")
- Professional business English, maximum 15 words each
- Varied — cover different capability dimensions`,
      },
      {
        id          : 'ground_matching',
        label       : 'Runtime — Ground Matching',
        description : 'Scores each ground\'s capability profile against a user question (0.0–1.0) to select the best AI assistant to route the question to.',
        prompt      : `You match a user question to the most capable AI assistant ground.

You are given a user question and one or more ground profiles. Each profile describes what
an AI assistant can do — its domains, capabilities, data sources, and limitations.

Score each ground with a confidence value from 0.0 to 1.0:
  1.0 — Perfect match: the ground explicitly handles this type of question
  0.7 — Strong match: the ground's domain covers this question
  0.4 — Partial match: tangentially related but not the primary use case
  0.1 — Weak match: possible but unlikely
  0.0 — No match: outside this ground's scope entirely

Return a JSON array with one object per ground, sorted by confidence descending:
[{ "groundId": "...", "confidence": 0.9, "reason": "one sentence" }, ...]

Return ONLY the JSON array. No explanation, no markdown.`,
      },
      {
        id          : 'anchor_discovery',
        label       : 'Walk — Semantic Anchor Discovery',
        description : 'Identifies two product-agnostic DOM anchors mid-walk: the "send busy" indicator (AI is processing) and the response container (where AI replies appear).',
        prompt      : `You are analysing the DOM of an AI assistant chat panel to identify two semantic anchors.

You will return a JSON object with exactly two fields:

  "sendBusy"          — CSS selector for the element that shows the AI is currently
                        processing/generating a response. Look for:
                        - A send/submit button with aria-disabled="true" or disabled attribute
                        - A loading spinner or progress indicator
                        Return null if no such element is visible in this DOM.

  "responseContainer" — CSS selector for the element type that contains AI response
                        messages in the chat thread. Look for:
                        - Elements with data-testid containing "message", "response", "chat"
                        - Elements with role="article" or role="log"
                        - Repeating container elements that hold message text
                        Return null if no such element is identifiable.

RULES:
- Return ONLY the JSON object. No explanation, no markdown.
- Prefer data-testid and aria-label selectors over class names.
- If uncertain, return null rather than guessing.`,
      },
      {
        id          : 'template_generation',
        label       : 'Legacy — One-Shot Template Generation',
        description : 'Legacy prompt for generating a full step template from a static DOM snapshot. Used for manual template creation outside the walk flow.',
        prompt      : `You are a senior browser automation engineer with deep expertise in testing AI agent products.

Your task is to generate a JSON step array that locates the AI assistant chat interface,
submits a test question, waits for the response, and extracts it.

The steps will be executed by a Chrome extension that can NAVIGATE, CLICK, TYPE, WAIT,
WAIT_FOR, FIND_AI, and EXTRACT. Use {{USER_QUESTION}} as the TYPE value placeholder.

Return ONLY the raw JSON array. No fences, no explanation.`,
      },
    ];
  }

  /** Returns the UI type registry for use in the side panel form and Prompts tab. */
  static getUiTypes() {
    return Object.entries(UI_TYPE_LABELS).map(([value, label]) => ({
      value,
      label,
      shape    : UI_TYPE_SHAPES[value],
      navHint  : UI_TYPE_NAV_HINTS[value],
      maxDepth : UI_TYPE_IFRAME_DEPTH[value] ?? 0,
    }));
  }

  /** Returns the max iframe recursion depth for a given uiType. */
  static getIframeDepth(uiType) {
    return UI_TYPE_IFRAME_DEPTH[uiType] ?? 1; // default 1 if unknown
  }

  // ── Prompt introspection ──────────────────────────────────────────────────

  /**
   * Returns all built-in system prompt texts keyed by prompt id.
   * Called by background.js GET_PROMPTS handler to serve the Docs tab.
   *
   * SYNC INVARIANT (v2.74.290) — the strings in this method are SNAPSHOTS
   * of the prompts assembled by the actual call-site methods (lines noted
   * below for each entry). Dynamic interpolation values are rendered as
   * `{placeholder}` markers. When a prompt's text changes at its call
   * site, update the corresponding snapshot here too — or the Docs tab
   * will show stale text. Future refactor: hoist each prompt to a
   * module-level builder so there's a single source of truth. For now
   * the catalog is curated by hand to keep the diff manageable.
   *
   * @returns {Record<string, string>}
   */
  static getPromptTexts() {
    const turn     = '{turn}';
    const SAMPLE_Q = '{sampleQuestion}';
    const INPUT_SEL = '{handoff.inputSelector}';
    return {

      proposePerspectiveStructure: `You organize a set of already-captured page landmarks into a structured "perspective" (a Perspective) for a web-automation library. You are given the perspective's name + intent and a flat list of landmarks (each: a stable "ref" id, an alias, a description). Infer the STRUCTURE — which landmarks contain others, their semantic roles, and how many occur at runtime.

Return ONLY a JSON object with "nodes" (a tree of { ref, role, multiplicity, contains? }), and optional "groupings" / "sequences" overlays.

Rules:
- Use ONLY the provided ref ids; never invent ids. EVERY provided landmark must appear EXACTLY ONCE in the nodes tree.
- "contains" = DOM-like containment (a section holds its items; a list holds its rows). Keep nesting shallow + meaningful.
- "role" = short lowercase semantic role (product-name, primary-action, results-list, result…). "multiplicity" = one|many|optional|conditional ("many" for repeating items).
- "groupings" = named clusters cutting across containment; "sequences" = ordered user-flow steps. Don't force structure that isn't there — flat roots are fine.

REFINE MODE (v2.74.347): when the call includes a PRIOR REVIEWED STRUCTURE, this becomes a refinement — each prior node/overlay carries a [judgment] ([accepted]/[edited]/[rejected-but-kept]). Preserve accepted/edited arrangements verbatim; re-think only rejected ones + landmarks new since the last proposal.`,

      proposePerspectives: `You propose PERSPECTIVE OPTIONS for a web-automation "Perspective", given the user's INTENT (what they want to do) and the current page. The description-first authoring flow (PERSPECTIVE_SPEC § 13): the user states intent, you propose 2-3 perspectives, the user picks one and fills its roles.

A perspective is a NAMED set of landmark ROLES — abstract slots the user fills by picking real elements. You name + describe roles; you do NOT pick elements or write selectors.

Return ONLY JSON: { "options": [ { "name": "<kebab>", "rationale": "<one line>", "roles": [ { "role": "<kebab>", "description": "<what fills it>", "multiplicity": "one|many|optional" } ], "predicates": [ { "kind": "urlMatches", "pattern": "<url substring>", "mode": "contains|exact|regex" } ] } ] }

Rules: 2-3 coherent options serving the intent; roles describe FUNCTION not appearance; predicates are urlMatches-only (landmarks don't exist yet); favor the stated intent over unrelated perspectives.`,

      deriveGroundDescription: `You are writing a short, factual summary of a "Ground" — a user's automation surface for a single website. The Ground is COMPOSED of Perspectives (each Perspective is a "kind of page" on the site, with a name and description). Synthesize what the WHOLE site-level automation surface is for, from its constituent Perspectives.

Return ONLY the summary text — no preamble, no JSON, no markdown headers, no surrounding quotes.

Rules:
- 1-3 sentences. Concise. Plain prose.
- Describe what the site is and what automation across these Perspectives accomplishes — the emergent whole, not a list of the Perspectives.
- Active voice, user's perspective. Do not invent capabilities not implied by the Perspectives.
- Do not restate the URL or repeat the Ground name verbatim as a label.`,

      getNextStep_phase1: `You are a browser automation engineer navigating to an AI assistant's chat input.

GOAL: Find and open the AI chat interface so the input is visible and focusable.

Permitted actions: NAVIGATE, CLICK, FIND_AI, WAIT, WAIT_FOR.
FORBIDDEN: TYPE, EXTRACT — do not interact with the AI yet.

You are done when an AI chat input is visible. Return FIND_AI to locate and click the AI entry point.
After FIND_AI or a CLICK that opens the panel, use WAIT_FOR to confirm the input appeared.

${SELECTOR_RULES}

TIMING RULES:
- After NAVIGATE: WAIT_FOR a landmark, timeout 10000.
- After CLICK opening a panel: WAIT_FOR the input inside, timeout 10000.
- WAIT only when nothing specific to wait for.

OUTPUT FORMAT: Return ONLY a single raw JSON object.
{"step":${turn},"action":"CLICK","selector":"[aria-label='Open Assistant']","value":""}`,

      getNextStep_phase2: `You are a browser automation engineer. The AI assistant panel is open.

This AI is known as: {aiName}. UI aliases: {aliases}.
Phase 1 identified the chat input as: {handoff.inputSelector} — verify against the DOM.

[UI TYPE SHAPE INJECTED HERE — one of the 5 DOM shape descriptions based on ground uiType setting]

YOUR TASK: Discover and execute the complete interaction path inside this panel:
  1. TYPE the question into the chat input
  2. CLICK the send/submit button
  3. EXTRACT the AI response

Read the DOM carefully. Use what you see — DOM is ground truth.

Permitted actions: TYPE, CLICK, WAIT, EXTRACT.
FORBIDDEN: NAVIGATE, FIND_AI, WAIT_FOR.

TYPE value rule (ABSOLUTE): must be exactly the sample question.
After the send CLICK: go DIRECTLY to EXTRACT — response-ready detection is automatic.
WAIT value must always be a plain numeric string e.g. "1500".

OUTPUT FORMAT: Return ONLY a single raw JSON object.
{"step":{turn},"action":"TYPE","selector":"[data-test-id='prose-mirror-chat-input']","value":"{sampleQuestion}"}`,

      generateSampleQuestion: `You generate a single opening message that a real user would type when first starting a conversation with an AI assistant.

Requirements:
- Natural, conversational first message — what a real person types when opening a chat
- Works for ANY AI assistant regardless of domain
- Short: under 10 words
- Sounds human — not robotic, not a test string
- Produces a real response
- Varies each time (examples: "What can you help me with?", "Where should I start?", "Walk me through what you can do")

Return ONLY the message text. No quotes, no explanation.`,

      discoverAnchors: `You are analysing the DOM of an AI assistant chat panel to identify two semantic anchors.

Return a JSON object with exactly two fields:

  "sendBusy" — CSS selector for the element that shows the AI is currently processing.
               Look for: send button with aria-disabled="true", loading spinner, progress indicator.
               Return null if not visible.

  "responseContainer" — CSS selector for the element type containing AI response messages.
                        Look for: elements with data-testid containing "message", "response", "chat".
                        Return null if not identifiable.

RULES:
- Return ONLY the JSON object.
- Prefer data-testid and aria-label selectors over class names.
- If uncertain, return null rather than guessing.`,

      generateProfileQuestions: `You generate introspective meta-questions to ask an AI assistant about its own capabilities.

These questions ask the AI ABOUT ITSELF — what it can do, what data it accesses, what it serves.

Good examples (introspective — ask the AI about itself):
- "What types of questions are you best equipped to answer?"
- "What data sources or records do you have direct access to?"
- "What business processes can you assist with in this platform?"
- "What kinds of requests are outside your current capabilities?"
- "What professional roles or teams do you primarily serve?"

Bad examples (task requests — do NOT generate these):
- "How do I improve my B2B campaign?" (task execution)
- "Find all contacts named John" (task execution)
- "Summarise my pipeline" (task execution)

Generate introspective meta-questions that together reveal:
1. Primary functional domains
2. Data sources accessible
3. Task types performed well
4. Known limitations and boundaries
5. Professional context and intended users

Return a JSON array of question strings. No explanation, no markdown.`,

      matchQuestionToGround: `You match a user question to the most capable AI assistant ground.

Score each ground with a confidence value from 0.0 to 1.0:
  1.0 — Perfect match: the ground explicitly handles this type of question
  0.7 — Strong match: the ground's domain covers this question
  0.4 — Partial match: tangentially related
  0.1 — Weak match: possible but unlikely
  0.0 — No match: outside this ground's scope

Return a JSON array sorted by confidence descending:
[{ "groundId": "...", "confidence": 0.9, "reason": "one sentence" }, ...]

Return ONLY the JSON array.`,

      generateTemplate: `You are a senior browser automation engineer.
Generate a JSON step array that locates the AI assistant chat interface,
submits {{USER_QUESTION}}, waits for the response, and extracts it.

Steps: NAVIGATE, CLICK, TYPE, WAIT, WAIT_FOR, FIND_AI, EXTRACT.
Use {{USER_QUESTION}} as the TYPE value placeholder.
Return ONLY the raw JSON array.`,

      // v2.67.2 — Static system prompt for Analysis T3 recovery.
      // Per-call dynamic content (operations, contract, indexed input,
      // cache output) is added to the user message at runtime and logged
      // via Logger.info during execution.
      recoverAnalysisFromCache: ANALYSIS_RECOVERY_SYSTEM_PROMPT,

      // v2.68.0 — Static system prompt for Analysis T3 primary execution
      // (frontier-tier Analyses whose author chose Frontier as the
      // primary tier). Per-call dynamic content (description, pre,
      // post, params, input) is added to the user message at runtime
      // and logged via Logger.info during execution.
      invokeAnalysisFrontierPrimary: ANALYSIS_FRONTIER_PRIMARY_SYSTEM_PROMPT,

      // v2.72.12+ — Frontier-tier vision Observation. Sent with a
      // screenshot + Observation record; returns bounding boxes for the
      // requested content via the locate_regions tool.
      observationFrontierVision: OBSERVATION_FRONTIER_VISION_SYSTEM_PROMPT,

      // ── Walk / Auto-mode runner ────────────────────────────────────
      // v2.74.290 — Added: snapshot of the live prompts in getNextTaskStep,
      // proposeNextStep, generateConversationTitle, generateTemplate,
      // extractStrategyParams. These power the auto-mode walk runner
      // that drives DOM actions one step at a time toward a stated goal.

      getNextTaskStep: `You are a browser automation engineer completing a task on a web page one step at a time.

TASK: {taskDesc}

CURRENT STEP ({stepNum} of {totalSteps}): {stepText}
{paramHint}

{completedSummary}
Generate DOM actions to complete the CURRENT STEP only.
When the current step is fully complete, output STEP_DONE to advance.
{isLastStepHint}

## Navigation and reload detection
If the context says "PAGE_NAVIGATED: The page navigated to X", the browser navigated to a new page.
If that navigation is the expected result of the current step, output STEP_DONE immediately.

If the context says "PAGE_RELOADED: The page reloaded unexpectedly", the page refreshed mid-task.
Re-orient to the current DOM snapshot and continue the task — do not restart from step 1.
If the reload returned to a login or session page, navigate back to the task URL first.

## DOM attributes (READ-ONLY — never use in selectors)
  text="..."              — visible text
  value="..."             — current value of an input/textarea (confirms field is filled)
  label-text="..."        — label text for radio/checkbox (identifies which option it is)
  checked="true"          — radio/checkbox is currently selected
  child-href="..."        — href of child anchor (reference only)
  use-selector="a[href='...']" — READY-TO-USE selector for this element — copy it exactly
  tag-hint="select"       — native <select> dropdown — use SELECT action, not CLICK
  options="A|B|C"         — pipe-separated options in a <select>
  new="true"              — appeared this turn
  changed="true"          — changed this turn
  disabled="true"         — element is disabled
  state-class="..."       — selection-state classes (selected, active, applied) — confirms post-click state
  signal-type="..."       — transient signal (toast/alert/banner/status/progress/validation-error)
  validation-text="..."   — on aria-invalid input, the message from aria-describedby
  aria-pressed/checked/selected/current="true" — SELECTION STATE
  aria-expanded="true"    — dropdown/popover is open

## Body-line attributes
  url="/path?query"       — current URL
  page-busy="true"        — page is loading/processing — WAIT, do not click again
  focused="tag#id"        — element currently holding focus

## Interpreting transient signals
"Saved", "Success", "Thank you", "Submitted" → action worked. Output STEP_DONE.
"Error", "Failed", "Invalid", specific complaints → action did NOT work. Fix the problem before re-submitting.
validation-text on aria-invalid input → fix that specific field before re-submitting.

## Selector rules
text/value/label-text/checked/child-href/use-selector/tag-hint/options/state-class/signal-type/validation-text/page-busy/focused/url do NOT exist in the DOM — never use as selector attributes.
When use-selector="..." is present, copy that value exactly as your selector.
For radio/checkbox: use the element's id selector (e.g. #nbsInfoBannerViewTile), not label-text.

## Selector preference order (strong to weak)
1. data-testid, data-test-id, data-key
2. aria-label exact match
3. role + text (e.g. button[aria-label='Apply'])
4. Unique class name that is NOT hashed (avoid .css-1a2b3c)
5. Visible text via use-selector hint
6. Structural path (last resort)
AVOID runtime-generated React ids like #:r9: — they're per-render.

## Do not repeat no-op actions
If "NO VISIBLE CHANGE" appears in lastStepError, do NOT repeat the same action. Pick a different selector, action type, or output STEP_DONE.

## Field verification
After TYPE or SELECT, the next snapshot confirms success via changed="true" or new nearby elements — not by matching the typed value.
Some fields transform input (autocomplete, formatting, date pickers) — displayed value may differ from typed. changed="true" is the signal.

## BLUR after TYPE
Always emit BLUR on the same selector immediately after every TYPE. Without it, Angular/React/Vue may discard the value.
Pattern: TYPE → BLUR → next action.

## Drawer/panel detection
Many new="true" items after a CLICK = panel opened. Click the target INSIDE — not the trigger again.

## Autocomplete inputs
TYPE → BLUR (same selector) → WAIT 1500 → CLICK the first suggestion.
Exception: when autocomplete parses input into multiple fields (address → street/city/state/zip), move BLUR after the suggestion CLICK.

## Actions
| action    | selector              | value                                        |
|-----------|-----------------------|----------------------------------------------|
| CLICK     | CSS selector          | "" (empty)                                   |
| TYPE      | CSS selector          | value or {{PARAM_NAME}}                      |
| BLUR      | CSS selector          | "" — fires blur/focusout                     |
| SELECT    | <select> selector     | option value, visible text, or index         |
| NAVIGATE  | "" (empty)            | full URL                                     |
| WAIT      | "" (empty)            | milliseconds e.g. "1500"                     |
| SCROLL_TO | CSS selector          | "" — scrolls into view, no DOM change        |
| STEP_DONE | "" (empty)            | "" — current step complete                   |
| DONE      | "" (empty)            | "" — entire task complete                    |

Use SELECT (not CLICK) for native <select> dropdowns.

## Capturing data
Do NOT emit EXTRACT or ENUMERATE — page→data capture belongs to the Observation primitive. If the step is a pure capture step, output STEP_DONE immediately.

## SCROLL_TO
Visibility-only. Use when description says "scroll to," "reveal," "show," "make visible." Do NOT use when a CLICK or TYPE follows on the same element (those handle visibility themselves). After SCROLL_TO, expect no DOM change — issue STEP_DONE next turn.

## CRITICAL: visibility-only tasks
If the description starts with "Scroll to," "Reveal," "Show," your FIRST action MUST be SCROLL_TO. Do NOT WAIT first.

OUTPUT FORMAT — CRITICAL:
Return a SINGLE LINE of raw JSON. No newlines inside the object. No markdown. No explanation.
CORRECT:   {"action":"CLICK","selector":"button[aria-label='Ship']","value":""}`,

      proposeNextStep: `You are assisting a user to automate a goal on a web page. Your job: propose the NEXT human-readable step toward the goal, given the current page state.

CURRENT GOAL: {goal}

GRANULARITY — a step is a user-visible action that takes roughly 5–30 seconds for a person to do. Examples:
  GOOD: "Open the job search form and enter '{{JOB_TITLE}}' as the search term"
  TOO SMALL: "Click the search button"   — DOM action, not a step
  TOO LARGE: "Complete the job application"   — the whole goal
  GOOD: "Fill in the shipping address with {{ADDRESS}}"
  GOOD: "Open the filters panel"
  GOOD: "Select the first matching result"

CONTEXT:
  Site URL: {groundUrl}
  Recent confirmed steps:
{historyText}{branchText}{rejectionsText}{hintsText}

Use {{PARAM_NAME}} tokens in the step text when the step operates on a variable value. Example: "Search for '{{JOB_TITLE}}' in '{{LOCATION}}'". Invent descriptive UPPER_SNAKE_CASE names.

Also provide a one-sentence rationale explaining WHY this is the right next step given the page state.

RESPOND WITH JSON ONLY — no code fences, no prose:
  To propose a step:
    { "kind": "propose", "text": "...", "rationale": "...", "params": ["PARAM1","PARAM2"] }
  If the goal appears to be fully accomplished:
    { "kind": "done", "rationale": "..." }
  If the goal is ambiguous:
    { "kind": "clarify", "question": "..." }`,

      // ── Discovery / Profiling ─────────────────────────────────────

      isResponseComplete: `You are analysing the DOM of an AI assistant chat panel to determine if the AI has finished responding.

Look at the response container elements ({responseContainer}) and determine:
- Is there a loading indicator, spinner, or streaming cursor visible?
- Does the last message element appear complete (ends with punctuation, has reasonable length)?
- Is the send button re-enabled (not aria-disabled)?

Return a JSON object: { "complete": true/false, "reason": "one sentence" }
Return ONLY the JSON object.`,

      summarizeSite: `You summarize a website for a structured automation library. Given a domain and a sample of pages crawled from it, return a JSON summary.

Return ONLY a JSON object with exactly these fields:
{
  "name": "...",                 // Short, recognizable site name (1-3 words). Use the brand, not the domain. Examples: "Pixabay", "Stack Overflow", "Reddit".
  "aliases": ["...", "..."],     // 2-6 alternate terms a user might call this site. Descriptive, not the same as the name.
  "description": "..."           // 1-2 sentences in active voice describing what a user can do on this site.
}

Rules:
- Be concrete. Avoid filler phrases like "is a website" or "is a platform".
- aliases should reflect how a user thinks about the site, not its branding.
- Skip empty / placeholder values — never return "Unknown" or empty strings.`,

      classifyPage: `You are a web page classifier helping build a structural map of a web app. Given a page's URL and a compact DOM snapshot, return a JSON classification.

Return ONLY a JSON object with exactly these fields:
{
  "pageType": "list" | "detail" | "form" | "confirmation" | "other",
  "formFields": [ { "label": "...", "selector": "...", "type": "...", "required": true/false } ],
  "outgoingLinks": [ { "text": "...", "href": "..." } ]
}

Classification rules:
- "form": page has a prominent input form (not just a search box). Include each field with its visible label.
- "list": page shows a repeating collection of similar items (tickets, jobs, records). Not a search results page.
- "detail": page shows a single structured entity.
- "confirmation": page shows a completed-action state.
- "other": doesn't fit the above.

For formFields: visible, non-hidden inputs only. selector uses real DOM attributes. label is the visible label. type is the HTML type. required reflects the required attribute.

For outgoingLinks: <a href> links to meaningful app pages. Max 8. Skip action links ("delete", "logout").

If none, return empty arrays.`,

      generateTaskProfile: `You generate a semantic routing profile for an automated browser task.

The profile matches natural-language user requests to this task at runtime.

Return a JSON object with exactly these fields:

"summary" — One sentence describing what this task does and what it produces.
"domains" — Array of 3–6 short strings describing the task's domain.
"triggers" — Array of 5–8 natural-language phrases a user might say to invoke this task.
"params" — Object mapping each parameter name to a one-sentence description.
"capabilities" — Array of 3–5 strings describing specific things this task can do.
"limitations" — Array of 2–3 strings describing what this task cannot do.

Return ONLY the JSON object. No explanation, no markdown.`,

      // ── Perspective / Landmark ─────────────────────────────────────────
      // v2.74.392 — suggestPerspective prompt removed with the legacy auto-suggest feature.

      suggestSelector: `You are a CSS selector expert. Given an HTML element and the author's intent (and possibly a cropped screenshot of the element region), output the most STABLE CSS selector that uniquely identifies the right element.

WHEN A SCREENSHOT IS PROVIDED:
Use it to disambiguate. The element the author wants is the one their cursor was on — described by the outerHTML AND the visible appearance in the image.

PRIORITIES (highest first):
1. Stable attribute selectors: [data-test-id="..."], [data-qa="..."], [aria-label="..."], [role="..."], #id (only when id is a human-readable slug).
2. Human-readable class-prefix matching: [class*="MarkdownBlock-"].
3. Tag + attribute combinations: button[aria-label="Copy message"].
4. AVOID: hashed class suffixes, positional :nth-of-type chains, deep > combinators with no anchor.

SHAPE / INTENT-SPECIFIC GUIDANCE:
- "click_copy_last" / "click_copy": prefer an interactive ancestor (<button>, [role="button"], <a>).
- "click" (fragment action): prefer an interactive ancestor with the onClick handler.
- "click_by_label" (fragment action): target a CONTAINER holding interactive items.
- "type" (fragment action): target an actual <input>, <textarea>, or [contenteditable].
- "select" (fragment action): target a <select> element directly.
- "wait_for" / "wait_for_gone": general presence/absence.
- "scroll_to": target the element to scroll into view.
- "text_last": runtime uses querySelectorAll().last — emit a selector that matches every feed item.
- "text": one element only.
- For any "_last" shape: selector should match N items (one per feed entry).

Output ONLY the CSS selector as a single line. No backticks, no quotes, no "Here's the selector:".`,

      generateLandmarkProfile: `You are building a landmark profile for a browser-automation authoring tool. A "landmark" is a named, reusable reference to a DOM element. Downstream consumers (fragment actions like CLICK / TYPE; observation extracts like text / attribute) will reference this landmark by name and trust the profile WITHOUT re-running their own checks.

Output ONE JSON object. No prose around it, no markdown code fences, no explanation — just the JSON.

Schema:
{
  "selector": "<stable CSS selector>",
  "description": "<1-2 sentences, second person>",
  "aliases": ["<alternate names>", ...],
  "operationsCommon": ["<typical ops>", ...],
  "pitfalls": ["<real gotchas>", ...],
  "expectedContent": { "kind": "<text|date|number|url|list|image>", "format": "<optional>", "example": "<optional>" } | null,
  "confidence": <0-1>,
  "rationale": "<one sentence>"
}

SELECTOR rules:
- The picker has ALREADY run a rule-based selector ladder (id > test-marker attrs > aria-label/name > stable class chain > structural) and produced a selector that resolves uniquely. That is the floor.
- Default behavior: ECHO the picker's selector back verbatim. Do NOT "refine" it because you think you can. Downstream code compares your selector's discriminator tier against the picker's and rejects any proposal not STRICTLY stronger.
- Only propose a different selector when you can demonstrably step UP the stability ladder.
- Output must be a pure CSS selector. NEVER use Playwright extensions: :has-text(...), :text-is(...), :text-matches(...), :contains(...), :visible, text=, xpath=, :near(...), :nth-match(...), :right-of/left-of/above/below(...).
- Avoid hashed class suffixes and positional :nth-of-type chains.

DESCRIPTION rules: second person, 1-2 sentences, max ~30 words. Use the screenshot to ground description in visible context.

ALIASES: 0-5 alternate names, lowercase-hyphenated.

OPERATIONS COMMON: 2-4 from the ALLOWED list provided in the user message. Order by likelihood.

PITFALLS: REAL gotchas you can see in the DOM context. Empty array when none.

EXPECTED CONTENT: only for extraction landmarks. null for pure action landmarks. kind: text | date | number | url | list | image.

CONFIDENCE: 0-1, self-reported.

RATIONALE: one short sentence explaining the selector choice.`,

      // ── Routing ────────────────────────────────────────────────────

      extractStrategyParams: `You extract parameter values from a user's natural-language request.

STRATEGY: {strategyName}
GOAL: {strategyGoal}

PARAMETERS TO EXTRACT:
{paramLines}

Return a JSON object with one field per parameter. If the user's message clearly specifies a value, extract it. If not mentioned, set it to null.

RULES:
- Copy the user's words verbatim when possible. Do not paraphrase.
- Do NOT invent values. Unspecified → null.
- UPPER_SNAKE_CASE param names usually map to common concepts (QUERY = search term, LOCATION = place, DATE = date phrase, AMOUNT = number, EMAIL = address).
- If a param is clearly present but ambiguous, pick the most specific extraction.

Return ONLY a JSON object: {"PARAM_NAME": "value" | null, ...}`,

      // ── Fragment / Assertion / Conditions ─────────────────────────

      proposeFragmentConditions: `You infer pre/post conditions for a reusable web automation Fragment.

A Fragment is a deterministic sequence of DOM actions that transforms page state from A to B. Its preconditions describe state A (when it's safe to run). Its postconditions describe state B (how to verify it succeeded). Conditions must be checkable from the DOM alone without running the Fragment.

FRAGMENT: {name}
DESCRIPTION: {description}

CONDITION GRAMMAR — return arrays of these:
  { "type": "selector_present", "selector": "..." }   — CSS selector matches ≥1 element
  { "type": "selector_absent",  "selector": "..." }   — CSS selector matches 0 elements
  { "type": "url_matches",      "pattern": "..." }    — location.href matches a regex
  { "type": "text_present",     "text": "..." }       — case-insensitive substring in body text

RULES:
- Prefer robust selectors: data-test-*, data-testid, role, aria-label, semantic HTML.
- Propose 2–4 preconditions and 2–4 postconditions.
- Preconditions identify the page/state where this Fragment makes sense.
- Postconditions prove the Fragment's effect succeeded.
- Do NOT fabricate selectors. Only reference elements actually in the DOM snapshots.
- If URLs differ from start to end, url_matches is often a strong postcondition.

RESPOND WITH JSON ONLY:
{
  "preconditions":  [ {...}, ... ],
  "postconditions": [ {...}, ... ],
  "rationale": "one sentence"
}`,

      composeAssertion: `You author a Assertion body — a saved condition expression referenced from primitive contracts.

A Assertion is **vocabulary**, not a primitive. It has no preconditions or postconditions of its own. It IS a condition expression: a {match, conditions} envelope evaluated as a single boolean against scope and page state at the point where it's referenced.

Your output:
  { "match": "all" | "any" | "k_of_n", "count"?: <int>, "conditions": [<condition>, ...] }

CONDITION VOCABULARY (family-restricted to: {allowedFamilies}):
{vocabularyHelp}

RULES:
- Output JSON ONLY. No code fences. No prose.
- Use 2-5 conditions.
- "all" (AND) is most common. Use "any" (OR) only when genuinely disjunctive. "k_of_n" (with explicit "count") for robust-against-page-variation.
- For page-family: prefer robust selectors (data-testid, role, aria-label).
- For scope-family: the binding name must reference what the caller will provide (INPUT is common for analyses).
- If the description doesn't clearly map, output an empty conditions array — never fabricate.

ASSERTION NAME: {name}
DESCRIPTION: {description}`,

      generateDetectConditions: `You generate DETECT branch conditions for a web automation procedure. The user walked an application and declared branch points where execution splits based on page state. For each branch, you must generate a condition that will be true at runtime ONLY when this branch should be taken.

Return ONLY a JSON object shaped like:
{
  "<branch_label>": { "type": "selector_present", "selector": "..." },
  "<branch_label>": { "type": "url_matches", "pattern": "..." }
}

Condition types:
- { "type": "selector_present", "selector": "..." }
- { "type": "selector_absent",  "selector": "..." }
- { "type": "url_matches",      "pattern": "..." }
- { "type": "text_present",     "text": "..." }

Rules:
- Prefer selector_present when branches are distinguished by DOM elements unique to each.
- Prefer url_matches when branches are distinguished by URL.
- Selectors must use real DOM attributes. Never fabricate.
- Conditions should be mutually exclusive across branches.
- If you cannot confidently pick a condition, use { "type": "selector_present", "selector": "" } — the user will fill it in manually.`,

      // ── Observation ───────────────────────────────────────────────

      extractSectionItems_url: `You distill a webpage section's link list into a curated array of meaningful URLs.

Return ONLY a JSON object with this shape:
{ "items": ["https://...", "https://...", ...] }

Rules:
- Keep navigable hyperlinks that lead to real pages or resources.
- Skip same-page anchors (href starts with "#"), mailto:, tel:, javascript:.
- Skip near-duplicates (same URL with only tracking-param differences).
- Resolve relative URLs against the sourceUrl when one is provided.
- Preserve the original ordering of the first occurrence of each URL.
- If nothing useful is present, return { "items": [] }.`,

      extractSectionItems_text: `You distill a webpage section's text content into a curated array of meaningful text values.

Return ONLY a JSON object with this shape:
{ "items": ["...", "...", ...] }

Rules:
- Include user-facing strings that carry real information: titles, product names, headings, prices, button labels, person names, key descriptors.
- Skip boilerplate ("Sign in", "Cookie consent", footer chrome, navigation), repeated UI strings, and stop phrases.
- Deduplicate. Preserve the order of first occurrence.
- Trim whitespace. Keep punctuation that's part of the value.
- If nothing useful is present, return { "items": [] }.`,

      readImage: `You read images and extract structured values requested by the user.

You receive:
  - An image (cropped region of a web page).
  - A description of what the user wants extracted from that image.

Return ONLY a JSON object with this shape:
{
  "items":      ["...", "...", ...],
  "confidence": 0.0,
  "rationale":  "..."
}

Rules:
- "items" is an array of distinct string values matching the user's description.
- If the description asks for a single value, return a one-element array.
- If the description asks for a list, return one entry per match in image order (top-to-bottom, left-to-right).
- Trim whitespace. Keep punctuation that's part of the value.
- Skip clearly-decorative or non-text-rendered elements unless explicitly asked.
- If nothing in the image satisfies the description, return { "items": [], "confidence": 0, "rationale": "..." }.
- Never invent values not visible in the image.
- "confidence" is 0 to 1 reflecting how sure you are. Subjective, not calibrated.
- "rationale" is one short sentence explaining the selection.`,

      // ── Misc ──────────────────────────────────────────────────────

      generateConversationTitle: `Generate a short conversation title of 4-6 words that summarizes the user's message. No punctuation, no quotation marks, no prefix like "Title:". Return only the title text itself.`,
    };
  }

  /**
   * Pass C — Extract strategy parameter values from a natural-language user
   * message. Given the Strategy's goal + param names and the user's message,
   * ask Claude to pull concrete values for each param (or mark them missing).
   *
   * Returns { params: { NAME: value }, missing: [NAME, ...] }.
   *
   * This is the routing-layer bridge: users say "find software engineer jobs
   * in Seattle" and we pull QUERY='software engineer', LOCATION='Seattle'.
   *
   * Behavior on failure: if the LLM call fails or returns unparseable output,
   * returns { params: {}, missing: [...all params...] } so the chat can fall
   * back to a fill-in form.
   *
   * @param {Object} opts
   * @param {string} opts.question
   * @param {string} opts.strategyName
   * @param {string} opts.strategyGoal
   * @param {string[]} opts.paramNames
   * @returns {Promise<{ params: Object, missing: string[], rationale?: string }>}
   */
  static async extractStrategyParams({ question, strategyName, strategyGoal, paramNames = [] }) {
    if (paramNames.length === 0) {
      return { params: {}, missing: [] };
    }

    const paramLines = paramNames.map(n => `  ${n}`).join('\n');

    const systemPrompt = `You extract parameter values from a user's natural-language request.

STRATEGY: ${strategyName}
GOAL: ${strategyGoal}

PARAMETERS TO EXTRACT:
${paramLines}

Return a JSON object with one field per parameter. If the user's message clearly specifies a value for a parameter, extract it. If the parameter isn't mentioned, set it to null.

RULES:
- Copy the user's words verbatim when possible. Do not paraphrase, expand, or interpret aggressively.
- Do NOT invent values. Unspecified → null.
- UPPER_SNAKE_CASE param names usually map to common concepts (QUERY = search term, LOCATION = place, DATE = date phrase, AMOUNT = number, EMAIL = address, etc.). Use your best judgment.
- If a param is clearly present but ambiguous, pick the most specific extraction.

Return ONLY a JSON object:
{
  "PARAM_NAME": "extracted value" | null,
  ...
}`;

    const userContent = `User message: "${String(question ?? '').slice(0, 600).replace(/"/g, "'")}"

Extract: ${paramNames.join(', ')}`;

    Logger.info('AnthropicService', `extractStrategyParams — "${strategyName}" (${paramNames.length} params)`);

    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 500);
      if (!raw?.success) {
        return { params: {}, missing: [...paramNames], rationale: raw?.error ?? 'LLM call failed' };
      }
      let text = String(raw.text ?? '').trim();
      const firstBrace = text.indexOf('{');
      const lastBrace  = text.lastIndexOf('}');
      if (firstBrace < 0 || lastBrace < firstBrace) {
        return { params: {}, missing: [...paramNames], rationale: 'No JSON object in response' };
      }
      text = text.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(text);

      const out = {};
      const missing = [];
      for (const name of paramNames) {
        const val = parsed[name];
        if (val === null || val === undefined || (typeof val === 'string' && val.trim() === '')) {
          missing.push(name);
        } else {
          out[name] = String(val).trim();
        }
      }
      return { params: out, missing };
    } catch (e) {
      Logger.warn('AnthropicService', `extractStrategyParams error: ${e.message}`);
      return { params: {}, missing: [...paramNames], rationale: e.message };
    }
  }

  /**
   * v2.67.0 (Pass 3b) — Frontier-tier recovery for failed Analysis cache.
   *
   * Invoked by ExecutionEngine when an Analysis's cache implementation
   * runs and produces output that violates the Analysis's postconditions,
   * AND the Analysis has `autoRecover: true`. The engine constructs a
   * recovery prompt from the Analysis's own artifacts (no author-written
   * prompt) and asks the model to produce an output that satisfies the
   * contract.
   *
   * Uses the tool-use API to constrain output: declares a tool whose
   * input_schema describes the expected output shape, then forces the
   * model to call that tool. The tool's input becomes the structured
   * output we parse.
   *
   * Per Pass 3b decisions:
   * - Hard cap of 50 input items. Larger lists fail with clear error.
   * - Cache output included in prompt for diagnostic context (truncated
   *   to first 5 items if cache returned > 5; otherwise full).
   * - Sonnet 4.5 model (the existing default).
   * - No retries on API failure (Pass 3b ships without retry; future).
   * - No caching of recovery results (Pass 3b ships without; future).
   *
   * v2.67.4 — Framing B: contract is binding, description + operations
   * are intent evidence. The Analysis's description field is the author's
   * stated purpose and is the primary signal of what the user wanted —
   * especially important when operations are derived from runtime params
   * that may not match the input data exactly. The model reconciles three
   * signals (purpose, operations, contract) rather than executing
   * operations literally.
   *
   * @param {Object} args
   * @param {string} args.analysisName          - For prompt context + logging.
   * @param {string} args.analysisDescription   - The Analysis's description field; author's stated intent.
   * @param {string} args.operationsDescription - From describeOperations().
   * @param {string} args.contractDescription   - From describeContract().
   * @param {Array}  args.inputItems            - The raw INPUT list.
   * @param {Array}  args.cacheOutputItems      - What cache produced (may be empty).
   * @returns {Promise<{success, indices, error, latencyMs, tokensIn, tokensOut}>}
   */
  static async invokeAnalysisRecovery({
    analysisName,
    analysisDescription,
    operationsDescription,
    contractDescription,
    inputItems,
    cacheOutputItems,
  }) {
    let _llm;
    try { _llm = await AnthropicService.#llmTransport(); }
    catch { return { success: false, items: [], error: 'No API key', latencyMs: 0, tokensIn: 0, tokensOut: 0 }; }

    // Hard cap on input list size. Larger lists would blow the prompt and
    // the cost budget; surface a clear error rather than silently truncating.
    const MAX_INPUT_ITEMS = 50;
    if (Array.isArray(inputItems) && inputItems.length > MAX_INPUT_ITEMS) {
      return {
        success: false,
        items: [],
        error: `Recovery input too large: ${inputItems.length} items (max ${MAX_INPUT_ITEMS})`,
        latencyMs: 0, tokensIn: 0, tokensOut: 0,
      };
    }

    // Truncate cache output for prompt context. We don't truncate input —
    // the model needs to see the full input it's working from. Cache
    // output is just diagnostic so seeing first few is sufficient.
    const cacheTruncated = Array.isArray(cacheOutputItems) && cacheOutputItems.length > 5
      ? cacheOutputItems.slice(0, 5)
      : (cacheOutputItems ?? []);
    const cacheNote = Array.isArray(cacheOutputItems) && cacheOutputItems.length > 5
      ? `\n(Showing first 5 of ${cacheOutputItems.length} cache output items.)`
      : '';

    // Strip iteration-engine machinery (selectors, internal indexes) from
    // items before sending. The model only needs the record fields.
    // Position indices are preserved by mapping in order — index `i` in
    // the prompt corresponds to position `i` in the original input.
    const stripItem = (item) => {
      if (!item || typeof item !== 'object') return item;
      // Items can be element-tagged with .record sub-field, record-tagged
      // with .fields, or plain objects.
      if (item.record && typeof item.record === 'object') return item.record;
      if (item.fields && typeof item.fields === 'object') return item.fields;
      return item;
    };
    const inputForPrompt  = (inputItems ?? []).map(stripItem);
    const cacheForPrompt  = cacheTruncated.map(stripItem);

    // Render the input as numbered items so the model sees positions
    // explicitly. The model returns indices; the engine maps those back
    // to original element-tagged items, preserving selectors and any
    // upstream identity (Pass 3b.fix — v2.67.2).
    const indexedInputText = inputForPrompt
      .map((item, i) => `[${i}] ${JSON.stringify(item)}`)
      .join('\n');

    const systemPrompt = ANALYSIS_RECOVERY_SYSTEM_PROMPT;

    // v2.67.4 — Description is the author's stated intent and the primary
    // signal under Framing B. Empty description is marked explicitly
    // rather than omitted, so the model doesn't infer that absence is
    // meaningful.
    const descriptionLine = analysisDescription && analysisDescription.trim()
      ? analysisDescription.trim()
      : '(no description provided by author)';

    const userContent = `Analysis: ${analysisName}

What this Analysis is for:
${descriptionLine}

Operations the rule-based attempt tried:
${operationsDescription}

Required output contract:
${contractDescription}

Input items (each prefixed with its index):
${indexedInputText}

What the rule-based attempt produced (for context):
${JSON.stringify(cacheForPrompt, null, 2)}${cacheNote}

Identify which input items satisfy the contract. Return their indices in the order they should appear in the output.`;

    // v2.67.2 — Tool schema is index-based. The implementation's operations
    // (filter, sort, take) are all identity-preserving — output items are
    // always a sub-arrangement of input items, never new records. The
    // model's job is selection: which items, in what order. Indexing
    // preserves the original input items' shape (element-tagged with
    // selectors and other upstream identity), which downstream code
    // depends on. Future op types that produce new records (classify,
    // summarize) will need a record-based schema as a separate branch.
    const tools = [{
      name: 'produce_recovered_output',
      description: 'Return indices into the input list for the items that satisfy the contract, along with self-reported confidence and a one-sentence rationale.',
      input_schema: {
        type: 'object',
        properties: {
          indices: {
            type: 'array',
            description: 'Indices into the input list, in output order. Empty array means no input items satisfy the contract.',
            items: { type: 'integer', minimum: 0 },
          },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Self-assessed confidence (0–1) that the selection correctly fulfills the description and contract. Not a calibrated probability.',
          },
          rationale: {
            type: 'string',
            description: 'One-sentence explanation of how you arrived at the selection. Especially valuable when confidence is low.',
          },
        },
        required: ['indices', 'confidence', 'rationale'],
      },
    }];

    const t0 = Date.now();

    // v2.67.3 — Full transcript logging. Every recovery call emits its
    // sent prompt and received response to the browser console via
    // Logger.info, so a user inspecting why recovery produced what it
    // did can read the actual content. The static system prompt is also
    // visible in the Prompts tab under "Analysis Recovery — Frontier (T3)".
    Logger.info('AnthropicService',
      `[recover ${analysisName}] SYSTEM PROMPT:\n${systemPrompt}`);
    Logger.info('AnthropicService',
      `[recover ${analysisName}] USER CONTENT:\n${userContent}`);

    try {
      const res = await fetch(_llm.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ..._llm.headers },
        body: JSON.stringify({
          model      : 'claude-sonnet-4-5',
          max_tokens : 4096,
          system     : systemPrompt,
          tools,
          // Force the model to call the tool, not produce free text.
          tool_choice: { type: 'tool', name: 'produce_recovered_output' },
          messages   : [{ role: 'user', content: userContent }],
        }),
      });
      const latencyMs = Date.now() - t0;

      if (!res.ok) {
        const body = await res.text();
        Logger.info('AnthropicService',
          `[recover ${analysisName}] HTTP ${res.status} ERROR:\n${body.slice(0, 1000)}`);
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = await res.json();
      const tokensIn  = data?.usage?.input_tokens  ?? 0;
      const tokensOut = data?.usage?.output_tokens ?? 0;

      // Find the tool_use content block. With tool_choice forced, there
      // should be exactly one. Defensive: handle absence as recovery
      // failure rather than throwing.
      const toolUse = Array.isArray(data?.content)
        ? data.content.find(b => b?.type === 'tool_use' && b?.name === 'produce_recovered_output')
        : null;
      if (!toolUse || !toolUse.input || !Array.isArray(toolUse.input.indices)) {
        const fallbackText = Array.isArray(data?.content)
          ? data.content.find(b => b?.type === 'text')?.text ?? '(no text)'
          : '(no content)';
        Logger.info('AnthropicService',
          `[recover ${analysisName}] RAW RESPONSE (no tool_use):\n${JSON.stringify(data?.content, null, 2)}`);
        Logger.warn('AnthropicService', `Recovery tool_use missing or malformed. Fallback text: ${fallbackText.slice(0, 200)}`);
        return {
          success: false, indices: [],
          confidence: null, rationale: null,
          error: 'Model did not call produce_recovered_output tool with indices',
          latencyMs, tokensIn, tokensOut,
        };
      }

      // Log raw indices the model returned (before validation).
      Logger.info('AnthropicService',
        `[recover ${analysisName}] RAW INDICES from model:\n${JSON.stringify(toolUse.input.indices)}`);

      // v2.68.0 — Extract confidence + rationale. Defensive: if model
      // omits or returns invalid types, log warning and use neutral
      // defaults. Don't reject otherwise-valid indices because of bad
      // metadata.
      const rawConfidence = toolUse.input.confidence;
      const confidence = (typeof rawConfidence === 'number' && rawConfidence >= 0 && rawConfidence <= 1)
        ? rawConfidence
        : null;
      if (confidence === null && rawConfidence !== undefined) {
        Logger.warn('AnthropicService',
          `Recovery for "${analysisName}": invalid confidence value (${rawConfidence}); treating as null`);
      }
      const rationale = (typeof toolUse.input.rationale === 'string')
        ? toolUse.input.rationale
        : '(no rationale provided)';

      Logger.info('AnthropicService',
        `[recover ${analysisName}] CONFIDENCE: ${confidence ?? 'null'}`);
      Logger.info('AnthropicService',
        `[recover ${analysisName}] RATIONALE: ${rationale}`);

      // Validate and dedupe indices. Out-of-range or duplicate indices
      // are silently filtered; preserve order. If all are invalid the
      // output is empty — postcondition re-check decides if that's
      // acceptable per the contract.
      const inputLength = (inputItems ?? []).length;
      const seen = new Set();
      const cleanIndices = [];
      let invalidCount = 0;
      for (const raw of toolUse.input.indices) {
        const idx = Number.isInteger(raw) ? raw : parseInt(raw, 10);
        if (!Number.isInteger(idx) || idx < 0 || idx >= inputLength) {
          invalidCount++;
          continue;
        }
        if (seen.has(idx)) continue;
        seen.add(idx);
        cleanIndices.push(idx);
      }
      if (invalidCount > 0) {
        Logger.warn('AnthropicService',
          `Recovery for "${analysisName}": ${invalidCount} invalid index(es) filtered out`);
      }

      // Log validated indices (final selection that goes back to the engine).
      Logger.info('AnthropicService',
        `[recover ${analysisName}] VALIDATED INDICES (after dedupe + range check):\n${JSON.stringify(cleanIndices)}`);

      Logger.info('AnthropicService',
        `Recovery succeeded for "${analysisName}": ${cleanIndices.length} indices, confidence ${confidence ?? 'null'}, ${latencyMs}ms, ${tokensIn}+${tokensOut} tokens`);
      return {
        success: true,
        indices: cleanIndices,
        confidence,
        rationale,
        error: null,
        latencyMs, tokensIn, tokensOut,
      };

    } catch (err) {
      const latencyMs = Date.now() - t0;
      Logger.error('AnthropicService', `Recovery API call failed for "${analysisName}": ${err.message}`);
      return {
        success: false, indices: [],
        confidence: null, rationale: null,
        error: err.message,
        latencyMs, tokensIn: 0, tokensOut: 0,
      };
    }
  }

  /**
   * v2.68.0 (Pass 3c) — Frontier-tier Analysis primary execution.
   *
   * Invoked by ExecutionEngine when an Analysis's primary tier is
   * 'frontier' — i.e., the author chose to author a model-invocation
   * Analysis instead of a rule-based one. There is no rule-based attempt
   * to recover from; the Analysis's body IS the model invocation.
   *
   * Distinct from invokeAnalysisRecovery:
   * - System prompt is "you are executing an Analysis," not "recovering."
   * - No operations description (no rule-based body exists).
   * - No cache output (none was produced).
   * - Tool output schema is open (`output: any`) — the contract validates
   *   the shape downstream.
   *
   * Per Pass 3c decisions:
   * - Hard cap of 50 input items (same as recovery).
   * - Sonnet 4.5 default model.
   * - System prompt sourced from ANALYSIS_FRONTIER_PRIMARY_SYSTEM_PROMPT
   *   const (single source of truth, mirrored in Prompts tab via
   *   getPromptTexts() under id 'invokeAnalysisFrontierPrimary').
   * - Confidence + rationale required in tool output (logged only;
   *   not contract-input or routing-criterion).
   *
   * @param {Object} args
   * @param {string} args.analysisName            - For prompt context + logging.
   * @param {string} args.analysisDescription     - The Analysis's description; primary intent signal.
   * @param {string} args.preconditionsDescription  - From describePreconditions(); structural facts about input.
   * @param {string} args.postconditionsDescription - From describeContract(); structural requirements on output.
   * @param {Object} args.params                  - Param name → bound value map (for prompt context).
   * @param {*}      args.inputValue              - The actual input (any shape — list, scalar, object).
   * @returns {Promise<{success, output, confidence, rationale, error, latencyMs, tokensIn, tokensOut}>}
   */
  static async invokeAnalysisFrontierPrimary({
    analysisName,
    analysisDescription,
    preconditionsDescription,
    postconditionsDescription,
    params,
    inputValue,
    // v2.72.21 (Pass 11) — Optional multimodal input. When present, the
    // image is sent as a content block alongside the text spec; inputValue
    // is omitted from the text (the image IS the input). Shape:
    //   {base64: string, mime: string, label?: string}
    imageInput = null,
  }) {
    let _llm;
    try { _llm = await AnthropicService.#llmTransport(); }
    catch {
      return {
        success: false, output: null, confidence: null, rationale: null,
        error: 'No API key',
        latencyMs: 0, tokensIn: 0, tokensOut: 0,
      };
    }

    // Hard cap for input lists. Other input shapes (scalar, single
    // object) aren't capped — they're inherently small.
    const MAX_INPUT_ITEMS = 50;
    if (Array.isArray(inputValue) && inputValue.length > MAX_INPUT_ITEMS) {
      return {
        success: false, output: null, confidence: null, rationale: null,
        error: `Frontier-primary input list too large: ${inputValue.length} items (max ${MAX_INPUT_ITEMS})`,
        latencyMs: 0, tokensIn: 0, tokensOut: 0,
      };
    }

    // Strip iteration-engine machinery from list items if input is a list.
    // For other shapes, pass through as-is.
    const stripItem = (item) => {
      if (!item || typeof item !== 'object') return item;
      if (item.record && typeof item.record === 'object') return item.record;
      if (item.fields && typeof item.fields === 'object') return item.fields;
      return item;
    };
    const inputForPrompt = Array.isArray(inputValue)
      ? inputValue.map(stripItem)
      : inputValue;

    const systemPrompt = ANALYSIS_FRONTIER_PRIMARY_SYSTEM_PROMPT;

    // Build user content. Empty/missing description marked explicitly.
    const descriptionLine = analysisDescription && analysisDescription.trim()
      ? analysisDescription.trim()
      : '(no description provided by author)';

    const preLine = preconditionsDescription && preconditionsDescription.trim()
      ? preconditionsDescription.trim()
      : '(none specified)';

    const postLine = postconditionsDescription && postconditionsDescription.trim()
      ? postconditionsDescription.trim()
      : '(none specified)';

    const paramsLine = params && typeof params === 'object' && Object.keys(params).length > 0
      ? JSON.stringify(params, null, 2)
      : '(none)';

    // Two text-spec variants: text-input (JSON inline) vs image-input
    // (image block separately, text references "the image above").
    let userTextSpec;
    if (imageInput) {
      const imgLabelLine = imageInput.label
        ? `Input image label: ${imageInput.label}`
        : 'Input is the image attached above.';
      userTextSpec = `Analysis: ${analysisName}

Description (what this Analysis is for):
${descriptionLine}

Preconditions (structural facts about the input):
${preLine}

Postconditions (structural requirements on the output):
${postLine}

Params (runtime values bound to this invocation):
${paramsLine}

${imgLabelLine}

Produce output that fulfills the description's intent and satisfies the postconditions.`;
    } else {
      userTextSpec = `Analysis: ${analysisName}

Description (what this Analysis is for):
${descriptionLine}

Preconditions (structural facts about the input):
${preLine}

Postconditions (structural requirements on the output):
${postLine}

Params (runtime values bound to this invocation):
${paramsLine}

Input data:
${JSON.stringify(inputForPrompt, null, 2)}

Produce output that fulfills the description's intent and satisfies the postconditions.`;
    }
    // Keep userContent variable name for compatibility with rest of method.
    const userContent = userTextSpec;

    // Tool definition. Output schema is open — the contract validates
    // shape downstream. Confidence + rationale required.
    const tools = [{
      name: 'produce_analysis_output',
      description: 'Return the output of the Analysis along with self-reported confidence and a one-sentence rationale.',
      input_schema: {
        type: 'object',
        properties: {
          output: {
            description: 'The Analysis output. Can be any JSON value (list, scalar, object, etc.) — shape should match what the postconditions require.',
          },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Self-assessed confidence (0–1) that the output correctly fulfills the description and contract. Not a calibrated probability.',
          },
          rationale: {
            type: 'string',
            description: 'One-sentence explanation of how you arrived at the output. Especially valuable when confidence is low.',
          },
        },
        required: ['output', 'confidence', 'rationale'],
      },
    }];

    const t0 = Date.now();

    Logger.info('AnthropicService',
      `[frontier-primary ${analysisName}] SYSTEM PROMPT:\n${systemPrompt}`);
    Logger.info('AnthropicService',
      `[frontier-primary ${analysisName}] USER CONTENT:\n${userContent}`);

    try {
      const res = await fetch(_llm.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ..._llm.headers },
        body: JSON.stringify({
          model      : 'claude-sonnet-4-5',
          max_tokens : 4096,
          system     : systemPrompt,
          tools,
          tool_choice: { type: 'tool', name: 'produce_analysis_output' },
          messages   : [{
            role: 'user',
            // v2.72.21 (Pass 11) — Multimodal when imageInput present;
            // text-only otherwise (existing path).
            content: imageInput
              ? [
                  {
                    type: 'image',
                    source: {
                      type      : 'base64',
                      media_type: imageInput.mime || 'image/png',
                      data      : imageInput.base64 || '',
                    },
                  },
                  { type: 'text', text: userContent },
                ]
              : userContent,
          }],
        }),
      });
      const latencyMs = Date.now() - t0;

      if (!res.ok) {
        const body = await res.text();
        Logger.info('AnthropicService',
          `[frontier-primary ${analysisName}] HTTP ${res.status} ERROR:\n${body.slice(0, 1000)}`);
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = await res.json();
      const tokensIn  = data?.usage?.input_tokens  ?? 0;
      const tokensOut = data?.usage?.output_tokens ?? 0;

      const toolUse = Array.isArray(data?.content)
        ? data.content.find(b => b?.type === 'tool_use' && b?.name === 'produce_analysis_output')
        : null;
      if (!toolUse || !toolUse.input || !('output' in toolUse.input)) {
        const fallbackText = Array.isArray(data?.content)
          ? data.content.find(b => b?.type === 'text')?.text ?? '(no text)'
          : '(no content)';
        Logger.info('AnthropicService',
          `[frontier-primary ${analysisName}] RAW RESPONSE (no tool_use):\n${JSON.stringify(data?.content, null, 2)}`);
        Logger.warn('AnthropicService', `Frontier-primary tool_use missing or malformed. Fallback text: ${fallbackText.slice(0, 200)}`);
        return {
          success: false, output: null, confidence: null, rationale: null,
          error: 'Model did not call produce_analysis_output tool',
          latencyMs, tokensIn, tokensOut,
        };
      }

      // Log raw output the model returned.
      Logger.info('AnthropicService',
        `[frontier-primary ${analysisName}] RAW OUTPUT from model:\n${JSON.stringify(toolUse.input.output, null, 2)}`);

      // Defensive parse of confidence + rationale (same pattern as recovery).
      const rawConfidence = toolUse.input.confidence;
      const confidence = (typeof rawConfidence === 'number' && rawConfidence >= 0 && rawConfidence <= 1)
        ? rawConfidence
        : null;
      if (confidence === null && rawConfidence !== undefined) {
        Logger.warn('AnthropicService',
          `Frontier-primary for "${analysisName}": invalid confidence value (${rawConfidence}); treating as null`);
      }
      const rationale = (typeof toolUse.input.rationale === 'string')
        ? toolUse.input.rationale
        : '(no rationale provided)';

      Logger.info('AnthropicService',
        `[frontier-primary ${analysisName}] CONFIDENCE: ${confidence ?? 'null'}`);
      Logger.info('AnthropicService',
        `[frontier-primary ${analysisName}] RATIONALE: ${rationale}`);

      Logger.info('AnthropicService',
        `Frontier-primary succeeded for "${analysisName}": confidence ${confidence ?? 'null'}, ${latencyMs}ms, ${tokensIn}+${tokensOut} tokens`);
      return {
        success: true,
        output: toolUse.input.output,
        confidence,
        rationale,
        error: null,
        latencyMs, tokensIn, tokensOut,
      };

    } catch (err) {
      const latencyMs = Date.now() - t0;
      Logger.error('AnthropicService', `Frontier-primary API call failed for "${analysisName}": ${err.message}`);
      return {
        success: false, output: null, confidence: null, rationale: null,
        error: err.message,
        latencyMs, tokensIn: 0, tokensOut: 0,
      };
    }
  }

  /**
   * v2.72.12 (Pass 9) — Frontier-tier Observation: vision-LLM coordinate
   * selection. The API call sends a screenshot + the Observation's authored
   * intent (name, description, pre/post, params) and asks the model to
   * return bounding box(es) for the requested content.
   *
   * Mirrors invokeAnalysisFrontierPrimary in shape: API key check,
   * fetch+tool_use, defensive parsing. Differences from the Analysis
   * frontier path:
   *   - Uses claude-opus-4-7 (1:1 pixel mapping, better visual localization).
   *   - Omits temperature / top_p / top_k — Opus 4.7 doesn't support them.
   *   - User content includes an image content block (the screenshot).
   *   - Tool name is 'locate_regions'; output schema is
   *     { regions: [...], confidence, rationale, partial_visibility }.
   *   - Returns regions for client-side cropping (no image generation
   *     happens server-side; the runtime crops based on coordinates).
   *
   * The system prompt and tool schema are sourced from the constants
   * declared at the top of this file (OBSERVATION_FRONTIER_VISION_SYSTEM_PROMPT
   * and OBSERVATION_FRONTIER_LOCATE_TOOL).
   *
   * @param {Object} args
   * @param {string} args.observationName            — for prompt context + logging.
   * @param {string} args.observationDescription     — primary intent signal; what to capture.
   * @param {string} args.shape                      — 'image' (single region) or 'image_list' (multiple).
   * @param {string} args.preconditionsDescription   — substituted human-readable pre.
   * @param {string} args.postconditionsDescription  — substituted human-readable post.
   * @param {string} args.targetHint                 — substituted CSS selector or empty.
   * @param {Object} args.params                     — param name → bound value map.
   * @param {string} args.screenshotBase64           — PNG base64 (no data: prefix).
   * @returns {Promise<{success, regions, confidence, rationale, partialVisibility, error, latencyMs, tokensIn, tokensOut}>}
   */
  static async invokeObservationFrontier({
    observationName,
    observationDescription,
    shape,
    preconditionsDescription,
    postconditionsDescription,
    targetHint,
    params,
    screenshotBase64,
  }) {
    const t0 = Date.now();
    let _llm;
    try { _llm = await AnthropicService.#llmTransport(); }
    catch {
      return {
        success: false, regions: [], confidence: null, rationale: null,
        partialVisibility: null,
        error: 'No API key',
        latencyMs: 0, tokensIn: 0, tokensOut: 0,
      };
    }
    if (!screenshotBase64 || typeof screenshotBase64 !== 'string') {
      return {
        success: false, regions: [], confidence: null, rationale: null,
        partialVisibility: null,
        error: 'Missing screenshot',
        latencyMs: Date.now() - t0, tokensIn: 0, tokensOut: 0,
      };
    }

    // Build user content: structured spec + screenshot. The system prompt
    // (OBSERVATION_FRONTIER_VISION_SYSTEM_PROMPT) is the procedure; the
    // user content is what varies per call.
    const descriptionLine = observationDescription && observationDescription.trim()
      ? observationDescription.trim()
      : '(no description provided by author)';
    const preLine = preconditionsDescription && preconditionsDescription.trim()
      ? preconditionsDescription.trim()
      : '(none specified)';
    const postLine = postconditionsDescription && postconditionsDescription.trim()
      ? postconditionsDescription.trim()
      : '(none specified)';
    const targetLine = targetHint && targetHint.trim()
      ? targetHint.trim()
      : 'none — full screenshot';
    const paramsLine = params && typeof params === 'object' && Object.keys(params).length > 0
      ? JSON.stringify(params, null, 2)
      : '(none)';

    const userTextSpec = `Observation: ${observationName ?? '(unnamed)'}
Description: ${descriptionLine}
Shape: ${shape}
Target hint: ${targetLine}

Preconditions:
${preLine}

Postconditions:
${postLine}

Params:
${paramsLine}

Identify the region(s) matching the description in the screenshot below and return via locate_regions.`;

    Logger.info('AnthropicService',
      `[obs-frontier ${observationName}] USER CONTENT:\n${userTextSpec}`);

    try {
      const res = await fetch(_llm.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ..._llm.headers },
        body: JSON.stringify({
          // Opus 4.7: pixel-level vision accuracy. No temperature/top_p/top_k —
          // those parameters are unsupported and would produce a 400.
          model      : MODEL_OBSERVATION_FRONTIER,
          max_tokens : 2048,
          system     : OBSERVATION_FRONTIER_VISION_SYSTEM_PROMPT,
          tools      : [OBSERVATION_FRONTIER_LOCATE_TOOL],
          tool_choice: { type: 'tool', name: 'locate_regions' },
          messages   : [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type      : 'base64',
                  media_type: 'image/png',
                  data      : screenshotBase64,
                },
              },
              { type: 'text', text: userTextSpec },
            ],
          }],
        }),
      });
      const latencyMs = Date.now() - t0;

      if (!res.ok) {
        const body = await res.text();
        Logger.info('AnthropicService',
          `[obs-frontier ${observationName}] HTTP ${res.status} ERROR:\n${body.slice(0, 1000)}`);
        return {
          success: false, regions: [], confidence: null, rationale: null,
          partialVisibility: null,
          error: `HTTP ${res.status}: ${body.slice(0, 200)}`,
          latencyMs, tokensIn: 0, tokensOut: 0,
        };
      }

      const data = await res.json();
      const tokensIn  = data?.usage?.input_tokens  ?? 0;
      const tokensOut = data?.usage?.output_tokens ?? 0;

      // Find the locate_regions tool_use block. With tool_choice forced,
      // there should be exactly one. Defensive: missing or malformed →
      // failure with a clear error message rather than throwing.
      const toolUse = Array.isArray(data?.content)
        ? data.content.find(b => b?.type === 'tool_use' && b?.name === 'locate_regions')
        : null;
      if (!toolUse || !toolUse.input || !Array.isArray(toolUse.input.regions)) {
        const fallbackText = Array.isArray(data?.content)
          ? data.content.find(b => b?.type === 'text')?.text ?? '(no text)'
          : '(no content)';
        Logger.info('AnthropicService',
          `[obs-frontier ${observationName}] RAW RESPONSE (no tool_use):\n${JSON.stringify(data?.content, null, 2)}`);
        Logger.warn('AnthropicService',
          `Observation tool_use missing or malformed. Fallback text: ${fallbackText.slice(0, 200)}`);
        return {
          success: false, regions: [], confidence: null, rationale: null,
          partialVisibility: null,
          error: 'Model did not call locate_regions tool with regions',
          latencyMs, tokensIn, tokensOut,
        };
      }

      // Extract + validate fields. Defensive on each: log warnings for
      // malformed values but don't reject the whole result if regions
      // themselves are well-formed.
      const rawConfidence = toolUse.input.confidence;
      const confidence = (typeof rawConfidence === 'number' && rawConfidence >= 0 && rawConfidence <= 1)
        ? rawConfidence
        : null;
      if (confidence === null && rawConfidence !== undefined) {
        Logger.warn('AnthropicService',
          `Observation "${observationName}": invalid confidence value (${rawConfidence}); treating as null`);
      }
      const rationale = (typeof toolUse.input.rationale === 'string')
        ? toolUse.input.rationale
        : null;
      const partialVisibility = toolUse.input.partial_visibility ?? null;

      // Validate each region: must have x1<x2, y1<y2, all in [0,1], plus
      // a non-empty label. Drop malformed regions with a warning.
      const validRegions = [];
      for (let i = 0; i < toolUse.input.regions.length; i++) {
        const r = toolUse.input.regions[i];
        if (!r || typeof r !== 'object') continue;
        const { x1, y1, x2, y2, label } = r;
        const isValidNum = (v) => typeof v === 'number' && v >= 0 && v <= 1 && Number.isFinite(v);
        if (!isValidNum(x1) || !isValidNum(y1) || !isValidNum(x2) || !isValidNum(y2)) {
          Logger.warn('AnthropicService',
            `Observation "${observationName}": region ${i} has invalid coordinates ${JSON.stringify({x1,y1,x2,y2})}`);
          continue;
        }
        if (x1 >= x2 || y1 >= y2) {
          Logger.warn('AnthropicService',
            `Observation "${observationName}": region ${i} has degenerate box (${x1},${y1})–(${x2},${y2})`);
          continue;
        }
        validRegions.push({
          x1, y1, x2, y2,
          label: (typeof label === 'string' && label.trim()) ? label.trim() : `region_${i}`,
        });
      }

      Logger.info('AnthropicService',
        `[obs-frontier ${observationName}] regions=${validRegions.length} confidence=${confidence} partial=${partialVisibility ? partialVisibility.kind : 'null'} latency=${latencyMs}ms`);

      return {
        success: true,
        regions: validRegions,
        confidence,
        rationale,
        partialVisibility,
        latencyMs,
        tokensIn,
        tokensOut,
      };

    } catch (err) {
      const latencyMs = Date.now() - t0;
      Logger.error('AnthropicService',
        `Frontier Observation API call failed for "${observationName}": ${err.message}`);
      return {
        success: false, regions: [], confidence: null, rationale: null,
        partialVisibility: null,
        error: err.message,
        latencyMs, tokensIn: 0, tokensOut: 0,
      };
    }
  }
}
