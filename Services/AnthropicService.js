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
import { CONDITION_FIELDS, getTypesByFamily } from './ConditionVocabulary.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL             = 'claude-sonnet-4-5';
// v2.72.12 (Pass 9) — Model string for frontier-tier Observation calls.
// Opus 4.7 has 1:1 pixel mapping for vision coordinates and supports
// images up to 2576px on the long edge. Per Anthropic docs, temperature/
// top_p/top_k are NOT supported on Opus 4.7 — we omit them.
const MODEL_OBSERVATION_FRONTIER = 'claude-opus-4-7';
const SETTINGS_KEY      = 'settings:anthropic_key';

// v2.74.154 — Per-million-token USD pricing for cost-metadata logging on
// LLM observations. Update when Anthropic changes published rates.
// Kept in this file (rather than a generic config) so the model strings
// above and the rate map below stay in lockstep — there's no scenario
// where we'd want one without the other.
const MODEL_PRICING_USD_PER_MILLION = Object.freeze({
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
// by Claude (generateLandmarkProfile, suggestLocale) and applies them
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

    const apiKey = await AnthropicService.getApiKey();
    if (!apiKey) return { success: false, step: null, error: 'No API key' };

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

    const apiKey = await AnthropicService.getApiKey();
    if (!apiKey) return { success: false, step: null, error: 'No API key' };

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

  /**
   * v2.74.43 — Ask Claude to suggest a Locale for the current page.
   * A Locale is a verified-landmark record: a kind-of-page descriptor
   * with role-keyed CSS selectors that automation Fragments and
   * Observations later reference.
   *
   * Returns:
   *   name        — short locale name ("Search results", "Product detail")
   *   description — 1-2 sentence summary of the page's purpose
   *   landmarks   — array of { role, selector }
   *
   * The DOM snapshot should be a sanitized representation of the page —
   * DiscoveryService's DOM_SNAPSHOT_RICH content-script call produces
   * the right shape (text-bearing landmarks, interactive controls,
   * stable id/name/aria attributes preserved).
   *
   * @param {Object} options
   * @param {string} options.url
   * @param {string} [options.title]
   * @param {string} options.domSnapshot
   * @returns {Promise<{ name: string, description: string, landmarks: Array<{role:string, selector:string}> } | null>}
   */
  static async suggestLocale({ url, title, domSnapshot }) {
    if (!url || !domSnapshot) return null;

    const systemPrompt = `You are identifying a Locale for a page in a structured automation library. A Locale is a "kind of page" descriptor — its name, what the page is for, and the durable DOM landmarks (alias → CSS selector) automation will reference.

Return ONLY a JSON object with exactly these fields:
{
  "name": "...",                                              // 2-4 word kind-of-page name. Examples: "Search results", "Product detail", "Sign-in form", "Cart". Not the site name.
  "description": "...",                                       // 1-2 sentences. What kind of page is this? What actions does it support? What data does it display?
  "landmarks": [                                              // 3-8 entries. Each is an alias + a CSS selector that resolves to ONE durable element on this page.
    { "alias": "search_input",     "selector": "#search" },
    { "alias": "results_list",     "selector": "ul.results" },
    { "alias": "filter_panel",     "selector": "aside.filters" }
  ]
}

Rules for landmarks:
- alias: snake_case, descriptive of FUNCTION not appearance ("submit_button", "results_list" — not "blue_button", "div_container").
- selector: pure CSS, usable by document.querySelectorAll. NEVER use Playwright / Cypress / jQuery pseudo-classes: :has-text, :text, :text-is, :text-matches, :contains, :visible, :nth-match, :near, :right-of, :left-of, :above, :below, text=, xpath=. They are NOT valid CSS and will throw at runtime.
- selector: use id, name, aria-label, or stable class chain. Never invented attributes. Pick the MOST stable selector — prefer #id, then [name], [aria-label], then a short stable class chain.
- Each selector must resolve to exactly ONE element. If a selector might match multiple, scope it tighter.
- Include only landmarks an automation script would actually care about: input fields, primary buttons, lists/result containers, navigational regions, key data displays. SKIP decorative chrome, footer links, cookie banners, social-media widgets.
- If the page has fewer than 3 useful landmarks, return what's there — don't pad with weak selectors.

Rules for name:
- Describe the page TYPE, not the brand. "Search results" not "Google search results".

Rules for description:
- Active voice from the user's perspective. "Browse and filter search results; click a result to open its detail page."`;

    const userContent = [{
      type: 'text',
      text: `URL: ${url}\nTitle: ${title ?? '(untitled)'}\n\nDOM snapshot:\n${String(domSnapshot).slice(0, 12000)}`,
    }];

    Logger.info('AnthropicService', `suggestLocale — ${url}`);

    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 1200, [], { role: 'propose', operation: 'suggestLocale' });
      if (!raw?.success) {
        Logger.warn('AnthropicService', `suggestLocale failed: ${raw?.error}`);
        return null;
      }
      let text = String(raw.text ?? '').trim();
      const firstBrace = text.indexOf('{');
      const lastBrace  = text.lastIndexOf('}');
      if (firstBrace < 0 || lastBrace < firstBrace) {
        Logger.warn('AnthropicService', `suggestLocale returned no JSON: ${text.slice(0, 200)}`);
        return null;
      }
      text = text.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(text);
      return {
        name        : typeof parsed.name === 'string' ? parsed.name.trim() : '',
        description : typeof parsed.description === 'string' ? parsed.description.trim() : '',
        // v2.74.287 — Drop any landmark whose selector contains a
        // Playwright / Cypress / jQuery pseudo. Unlike generateLandmark-
        // Profile (which has currentSelector as a fallback floor),
        // suggestLocale has no picker selector to substitute, so the
        // safest action is to skip the offender rather than surface a
        // landmark whose verify call will throw SyntaxError on every
        // re-open of the locale.
        landmarks   : Array.isArray(parsed.landmarks)
          ? parsed.landmarks
              .filter(lm => lm && typeof lm.alias === 'string' && typeof lm.selector === 'string')
              .map(lm => ({ alias: lm.alias.trim(), selector: lm.selector.trim() }))
              .filter(lm => lm.alias && lm.selector)
              .filter(lm => {
                if (_looksLikePlaywrightSelector(lm.selector)) {
                  Logger.warn('AnthropicService', `suggestLocale: dropping landmark "${lm.alias}" — Playwright-style selector "${lm.selector.slice(0, 120)}" is not valid CSS`);
                  return false;
                }
                return true;
              })
          : [],
      };
    } catch (e) {
      Logger.warn('AnthropicService', `suggestLocale error: ${e.message}`);
      return null;
    }
  }

  /**
   * v2.74.329 — GROUND_SPEC § 5 derived intent. Synthesize a short
   * natural-language summary of "what this Ground is for" from its
   * constituent Locales' names + descriptions. Returns plain text (no JSON)
   * or null on failure. Prompt snapshot registered in getPromptTexts under
   * 'deriveGroundDescription'.
   * @param {{ name?: string, urlPrimary?: string, locales: Array<{name?:string, description?:string}> }} params
   * @returns {Promise<string|null>}
   */
  static async deriveGroundDescription({ name, urlPrimary, locales }) {
    const list = Array.isArray(locales) ? locales.filter(l => l && (l.name || l.description)) : [];
    if (list.length === 0) return null;

    const systemPrompt = `You are writing a short, factual summary of a "Ground" — a user's automation surface for a single website. The Ground is COMPOSED of Locales (each Locale is a "kind of page" on the site, with a name and description). Synthesize what the WHOLE site-level automation surface is for, from its constituent Locales.

Return ONLY the summary text — no preamble, no JSON, no markdown headers, no surrounding quotes.

Rules:
- 1-3 sentences. Concise. Plain prose.
- Describe what the site is and what automation across these Locales accomplishes — the emergent whole, not a list of the Locales.
- Active voice, user's perspective. Do not invent capabilities not implied by the Locales.
- Do not restate the URL or repeat the Ground name verbatim as a label.`;

    const localeBlock = list.map((l, i) =>
      `${i + 1}. ${l.name ?? '(unnamed)'}: ${(l.description ?? '').trim() || '(no description)'}`
    ).join('\n');

    const userContent = [{
      type: 'text',
      text: `Ground name: ${name ?? '(unnamed)'}\nPrimary URL: ${urlPrimary ?? '(unknown)'}\n\nConstituent Locales:\n${localeBlock}`,
    }];

    Logger.info('AnthropicService', `deriveGroundDescription — "${name ?? '?'}" from ${list.length} locale(s)`);

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
   * v2.74.336 — LOCALE_SPEC § 3 Layer 2 / § 13 LLM-as-author. Organize a
   * set of already-captured landmarks into a structured perspective:
   * a LandmarkNode[] tree (contains/role/multiplicity) + optional
   * groupings/sequences overlays. The LLM proposes structure; the user
   * reviews. Returns null on failure. Prompt snapshot registered in
   * getPromptTexts under 'proposeLocaleStructure'.
   *
   * v2.74.347 — LOCALE_SPEC § 5 review-as-input. When the caller passes
   * `priorStructure` (the structure the user already reviewed, with per-node
   * `authoringMetadata.userJudgment`), this becomes a REFINE call: the prior
   * accepted/edited arrangements are preserved and the rejected ones are
   * re-thought, instead of proposing from a blank slate. This is what makes
   * the structured tree + the user's judgments an actual downstream consumer.
   *
   * @param {{ name?: string, description?: string, landmarks: Array<{uid:string, alias?:string, description?:string}>, priorStructure?: { nodes?: Array, groupings?: Array, sequences?: Array } }} params
   * @returns {Promise<{ nodes: Array, groupings: Array, sequences: Array }|null>}
   */
  static async proposeLocaleStructure({ name, description, landmarks, priorStructure }) {
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

    const systemPrompt = `You organize a set of already-captured page landmarks into a structured "perspective" (a Locale) for a web-automation library. You are given the perspective's name + intent and a flat list of landmarks (each: a stable "ref" id, an alias, a description). Infer the STRUCTURE — which landmarks contain others, their semantic roles, and how many occur at runtime.

Return ONLY a JSON object:
{
  "nodes": [
    { "ref": "<id>", "role": "results-list", "multiplicity": "one",
      "contains": [ { "ref": "<id>", "role": "result", "multiplicity": "many" } ] }
  ],
  "groupings": [ { "name": "buying-flow", "members": ["<id>", "<id>"] } ],
  "sequences": [ { "name": "checkout-steps", "steps": ["<id>", "<id>"] } ]
}

Rules:
- Use ONLY the provided ref ids. Never invent ids.
- EVERY provided landmark must appear EXACTLY ONCE in the "nodes" tree — as a root or nested inside some node's "contains".
- "contains" = DOM-like containment: use it when one landmark logically holds others (a section holds its items; a list holds its rows). Keep nesting shallow and meaningful.
- "role" = short lowercase semantic role within the parent (e.g. product-name, primary-action, results-list, result, price-current, review). 1-3 words, kebab-case.
- "multiplicity" = one | many | optional | conditional. Use "many" for repeating items (list rows, reviews); default "one".
- "groupings" (optional) = named clusters that cut across containment (e.g. all controls in a buying flow). "members" are ref ids.
- "sequences" (optional) = ordered user-flow steps. "steps" are ref ids in order.
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

    const lmBlock = list.map(l =>
      `- ref: ${l.uid}\n  alias: ${l.alias ?? '(none)'}\n  desc: ${(l.description ?? '').trim() || '(none)'}`
    ).join('\n');
    const userContent = [{
      type: 'text',
      text: `Perspective name: ${name ?? '(unnamed)'}\nIntent: ${(description ?? '').trim() || '(none)'}\n\nLandmarks:\n${lmBlock}${refining ? `\n\nPRIOR REVIEWED STRUCTURE (refine this):\n${priorBlock}` : ''}`,
    }];

    Logger.info('AnthropicService', `proposeLocaleStructure — "${name ?? '?'}" over ${list.length} landmark(s)${refining ? ' [refine]' : ''}`);

    let parsed;
    try {
      const raw = await AnthropicService.#call(systemPrompt, userContent, 1500, [], { role: 'propose', operation: priorStructure ? 'proposeLocaleStructure:refine' : 'proposeLocaleStructure' });
      if (!raw?.success) {
        Logger.warn('AnthropicService', `proposeLocaleStructure failed: ${raw?.error}`);
        return null;
      }
      const json = AnthropicService.#firstJsonObject(raw.text);
      if (!json) { Logger.warn('AnthropicService', 'proposeLocaleStructure: no JSON'); return null; }
      parsed = JSON.parse(json);
    } catch (e) {
      Logger.warn('AnthropicService', `proposeLocaleStructure error: ${e.message}`);
      return null;
    }

    // ── Safety sanitizer ──────────────────────────────────────────────
    // Clamp refs to the allowed set, dedupe (first occurrence wins), clamp
    // role/multiplicity, then append any provided landmark the LLM dropped
    // as a flat root — so the stored composition NEVER loses a landmark.
    const MULT = new Set(['one', 'many', 'optional', 'conditional']);
    const seen = new Set();
    const sanitizeNodes = (arr) => {
      const out = [];
      for (const n of Array.isArray(arr) ? arr : []) {
        const ref = (n && typeof n.ref === 'string') ? n.ref : null;
        if (!ref || !allowed.has(ref) || seen.has(ref)) {
          // unknown / duplicate ref — skip the node but still recurse its
          // children (they may be valid).
          if (n && Array.isArray(n.contains)) out.push(...sanitizeNodes(n.contains));
          continue;
        }
        seen.add(ref);
        const node = { ref };
        if (typeof n.role === 'string' && n.role.trim()) node.role = n.role.trim().slice(0, 40);
        if (typeof n.multiplicity === 'string' && MULT.has(n.multiplicity)) node.multiplicity = n.multiplicity;
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
   * for the refine path of proposeLocaleStructure. Refs are clamped to the
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
        if (ref && allowed.has(ref)) {
          const pad  = '  '.repeat(depth);
          const role = (typeof n.role === 'string' && n.role.trim()) ? ` role=${n.role.trim()}` : '';
          const mult = (typeof n.multiplicity === 'string' && n.multiplicity.trim()) ? ` mult=${n.multiplicity.trim()}` : '';
          out += `${pad}- ref: ${ref} (${aliasOf.get(ref) ?? '?'})${role}${mult}${mark(n)}\n`;
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
   * v2.74.348 — LOCALE_SPEC § 13 / § 16 priority 6: the description-first,
   * LLM-mediated PROPOSAL flow. Given the user's INTENT (the Locale
   * description) and the current page, propose 2–3 PERSPECTIVE OPTIONS — each
   * a named set of landmark ROLES to fill (NOT concrete selectors; the user
   * picks the real elements) plus suggested URL-applicability predicates and a
   * one-line rationale. This is the inverse of suggestLocale (page-seeded,
   * concrete landmarks) — it is intent-seeded and role-scaffolded, per the
   * canonical "LLM as proposal layer, user as committer" pattern.
   *
   * v2.74.350 — Optional ENHANCED context (the benchmark's B arm). All three
   * are additive — when omitted the call is byte-identical to the baseline, so
   * an A/B isolates the value of the added context, holding the DOM constant:
   *   - screenshot:        data:image/...;base64 of the visible page (multimodal
   *                        grounding for layout / prominence / repetition).
   *   - siblingLocales:    [{ name, description, roles[] }] already on this
   *                        Ground — avoid duplicates, reuse role vocabulary.
   *   - registryLandmarks: [{ alias, a11yRole, description }] already captured
   *                        on this Ground — roles may map to existing landmarks.
   *
   * @param {{ intent: string, url?: string, title?: string, domSnapshot?: string, screenshot?: string|null, siblingLocales?: Array|null, registryLandmarks?: Array|null }} params
   * @returns {Promise<{ options: Array<{name:string, rationale:string, onPage:boolean, reachedVia:string|null, roles:Array<{role:string,description:string,multiplicity:string}>, predicates:Array<{kind:'urlMatches',pattern:string,mode:string}>}> }|null>}
   */
  static async proposePerspectives({ intent, url, title, domSnapshot, screenshot = null, siblingLocales = null, registryLandmarks = null }) {
    const seed = (typeof intent === 'string' ? intent : '').trim();
    if (!seed) return null;

    const systemPrompt = `You propose PERSPECTIVE OPTIONS for a web-automation "Locale" (a reusable "kind of page" view). You are given the user's INTENT (what they want to do) and the current page. Propose 2-3 distinct perspectives that serve the intent on this page.

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
        { "role": "search-input", "description": "the text box where the query is typed", "multiplicity": "one" },
        { "role": "result-item",  "description": "a single result row in the list",        "multiplicity": "many" }
      ],
      "predicates": [
        { "kind": "urlMatches", "pattern": "/search", "mode": "contains" }
      ]
    }
  ]
}

Rules:
- 2-4 options. Each must be a COHERENT perspective serving the stated intent — not a grab-bag.
- "name" = short kebab-case identifier for the perspective ("search-results", "product-detail", "checkout-form").
- "roles" = 2-8 per option. "role" is a short kebab-case semantic name; "description" says what element fills it (so the user knows what to pick); "multiplicity" is one | many | optional.
- Roles describe FUNCTION, not appearance ("primary-action", "result-item" — not "blue-button", "div-3").
- "predicates" (optional) = ONLY urlMatches entries that declare where this perspective applies. "pattern" is a URL substring/regex/exact string; "mode" is contains | exact | regex. Do NOT propose landmark-based predicates — the landmarks don't exist yet. Omit predicates if no reliable URL signal.
- "onPage" = true if THIS perspective's elements are present on the CURRENT page you are analyzing; false if it belongs to a DOWNSTREAM page reached only AFTER acting (e.g., the results page that appears after submitting a search, or a detail page after clicking a result). Judge this from the actual page content/screenshot.
- "reachedVia" = for a downstream perspective (onPage:false), a SHORT phrase for how you reach it from the current page ("after submitting the search", "after clicking a result"). null for on-page perspectives.
- List the on-page perspective(s) FIRST. You MAY include downstream perspectives that complete the intent's journey, but mark them onPage:false — the user can only fill a perspective's roles once they are on its page.
- Favor the intent. If the intent is narrow ("capture search results"), don't propose unrelated perspectives.`;

    // Base context — identical in baseline and enhanced runs, so the A/B
    // measures the ADDED context (screenshot + library) holding the DOM fixed.
    let userText = `Intent: ${seed}\nURL: ${url ?? '(unknown)'}\nTitle: ${title ?? '(unknown)'}\n\nPage (sanitized DOM):\n${(domSnapshot ?? '').slice(0, 12000)}`;

    // Enhanced — perspectives already on this Ground: avoid duplicating them,
    // prefer complementary ones, and reuse their role vocabulary.
    if (Array.isArray(siblingLocales) && siblingLocales.length) {
      const block = siblingLocales.slice(0, 12).map(l => {
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
      || (Array.isArray(siblingLocales) && siblingLocales.length)
      || (Array.isArray(registryLandmarks) && registryLandmarks.length);

    Logger.info('AnthropicService', `proposePerspectives [${enhanced ? 'enhanced' : 'baseline'}] — intent="${seed.slice(0, 60)}"`);

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
        roles.push({
          role,
          description: (typeof r?.description === 'string' ? r.description.trim() : '').slice(0, 160),
          multiplicity: MULT.has(r?.multiplicity) ? r.multiplicity : 'one',
        });
        if (roles.length >= 10) break;
      }
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
    if (options.length === 0) return null;
    return { options };
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
  static async resolveRoles({ roles, url, title, domSnapshot, screenshot = null, registryLandmarks = null, priorAttempt = null }) {
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
- Prefer durable hooks: id, data-testid / data-*, name, aria-label, role, type, semantic tags. AVOID nth-child chains, hashed/auto-generated class names, and long brittle descendant chains.
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

    const raw = await AnthropicService.#call(systemPrompt, userContent, 512, [
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

    const apiKey = await AnthropicService.getApiKey();
    if (!apiKey) return { success: false, rawJson: null, steps: null, error: 'No Anthropic API key set. Add it in Settings.' };

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
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const t0 = now();
    const apiKey = await AnthropicService.getApiKey();
    if (!apiKey) {
      AnthropicService.#audit({ ts: Date.now(), role, operation, latencyMs: 0, ok: false, outputChars: 0, model: MODEL, error: 'no-api-key' });
      return { success: false, text: '', error: 'No API key' };
    }

    const messages = [
      { role: 'user', content: userContent },
      ...extraMessages,
    ];

    try {
      const res = await fetch(ANTHROPIC_API_URL, {
        method : 'POST',
        headers: {
          'Content-Type'                             : 'application/json',
          'x-api-key'                                : apiKey,
          'anthropic-version'                        : '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model      : MODEL,
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
      AnthropicService.#audit({ ts: Date.now(), role, operation, latencyMs: Math.round(now() - t0), ok: true, outputChars: text.length, model: MODEL });
      Logger.debug('AnthropicService', `API call success — ${text.length} chars [${role}/${operation}]`, usage);
      return { success: true, text, error: null, usage };

    } catch (err) {
      AnthropicService.#audit({ ts: Date.now(), role, operation, latencyMs: Math.round(now() - t0), ok: false, outputChars: 0, model: MODEL, error: String(err.message).slice(0, 120) });
      Logger.error('AnthropicService', `API call failed [${role}/${operation}]: ${err.message}`);
      return { success: false, text: '', error: err.message };
    }
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

      proposeLocaleStructure: `You organize a set of already-captured page landmarks into a structured "perspective" (a Locale) for a web-automation library. You are given the perspective's name + intent and a flat list of landmarks (each: a stable "ref" id, an alias, a description). Infer the STRUCTURE — which landmarks contain others, their semantic roles, and how many occur at runtime.

Return ONLY a JSON object with "nodes" (a tree of { ref, role, multiplicity, contains? }), and optional "groupings" / "sequences" overlays.

Rules:
- Use ONLY the provided ref ids; never invent ids. EVERY provided landmark must appear EXACTLY ONCE in the nodes tree.
- "contains" = DOM-like containment (a section holds its items; a list holds its rows). Keep nesting shallow + meaningful.
- "role" = short lowercase semantic role (product-name, primary-action, results-list, result…). "multiplicity" = one|many|optional|conditional ("many" for repeating items).
- "groupings" = named clusters cutting across containment; "sequences" = ordered user-flow steps. Don't force structure that isn't there — flat roots are fine.

REFINE MODE (v2.74.347): when the call includes a PRIOR REVIEWED STRUCTURE, this becomes a refinement — each prior node/overlay carries a [judgment] ([accepted]/[edited]/[rejected-but-kept]). Preserve accepted/edited arrangements verbatim; re-think only rejected ones + landmarks new since the last proposal.`,

      proposePerspectives: `You propose PERSPECTIVE OPTIONS for a web-automation "Locale", given the user's INTENT (what they want to do) and the current page. The description-first authoring flow (LOCALE_SPEC § 13): the user states intent, you propose 2-3 perspectives, the user picks one and fills its roles.

A perspective is a NAMED set of landmark ROLES — abstract slots the user fills by picking real elements. You name + describe roles; you do NOT pick elements or write selectors.

Return ONLY JSON: { "options": [ { "name": "<kebab>", "rationale": "<one line>", "roles": [ { "role": "<kebab>", "description": "<what fills it>", "multiplicity": "one|many|optional" } ], "predicates": [ { "kind": "urlMatches", "pattern": "<url substring>", "mode": "contains|exact|regex" } ] } ] }

Rules: 2-3 coherent options serving the intent; roles describe FUNCTION not appearance; predicates are urlMatches-only (landmarks don't exist yet); favor the stated intent over unrelated perspectives.`,

      deriveGroundDescription: `You are writing a short, factual summary of a "Ground" — a user's automation surface for a single website. The Ground is COMPOSED of Locales (each Locale is a "kind of page" on the site, with a name and description). Synthesize what the WHOLE site-level automation surface is for, from its constituent Locales.

Return ONLY the summary text — no preamble, no JSON, no markdown headers, no surrounding quotes.

Rules:
- 1-3 sentences. Concise. Plain prose.
- Describe what the site is and what automation across these Locales accomplishes — the emergent whole, not a list of the Locales.
- Active voice, user's perspective. Do not invent capabilities not implied by the Locales.
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

      // ── Locale / Landmark ─────────────────────────────────────────

      suggestLocale: `You are identifying a Locale for a page in a structured automation library. A Locale is a "kind of page" descriptor — its name, what the page is for, and the durable DOM landmarks (alias → CSS selector) automation will reference.

Return ONLY a JSON object with exactly these fields:
{
  "name": "...",                  // 2-4 word kind-of-page name. Examples: "Search results", "Product detail", "Sign-in form".
  "description": "...",           // 1-2 sentences. What kind of page is this? What actions does it support? What data does it display?
  "landmarks": [                  // 3-8 entries. Each is an alias + CSS selector that resolves to ONE durable element.
    { "alias": "search_input",   "selector": "#search" },
    { "alias": "results_list",   "selector": "ul.results" },
    { "alias": "filter_panel",   "selector": "aside.filters" }
  ]
}

Rules for landmarks:
- alias: snake_case, descriptive of FUNCTION not appearance ("submit_button", "results_list" — not "blue_button").
- selector: pure CSS, usable by document.querySelectorAll. NEVER use Playwright / Cypress / jQuery pseudo-classes: :has-text, :text, :text-is, :text-matches, :contains, :visible, :nth-match, :near, :right-of, :left-of, :above, :below, text=, xpath=. They are NOT valid CSS and will throw at runtime.
- selector: use id, name, aria-label, or stable class chain. Prefer #id, then [name], [aria-label], then a short stable class chain.
- Each selector must resolve to exactly ONE element.
- Include only landmarks an automation script would actually care about. SKIP decorative chrome, footer links, cookie banners.

Rules for name: describe the page TYPE, not the brand. "Search results" not "Google search results".

Rules for description: active voice from the user's perspective.`,

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
    const apiKey = await AnthropicService.getApiKey();
    if (!apiKey) {
      return { success: false, items: [], error: 'No API key', latencyMs: 0, tokensIn: 0, tokensOut: 0 };
    }

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
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type'                             : 'application/json',
          'x-api-key'                                : apiKey,
          'anthropic-version'                        : '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
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
    const apiKey = await AnthropicService.getApiKey();
    if (!apiKey) {
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
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type'                             : 'application/json',
          'x-api-key'                                : apiKey,
          'anthropic-version'                        : '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
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
    const apiKey = await AnthropicService.getApiKey();
    if (!apiKey) {
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
      const res = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type'                             : 'application/json',
          'x-api-key'                                : apiKey,
          'anthropic-version'                        : '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
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
