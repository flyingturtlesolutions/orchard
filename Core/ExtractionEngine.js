/**
 * @file Core/ExtractionEngine.js
 * @description Captures a sanitised DOM snapshot (scripts/styles stripped) and a
 * base64 screenshot of the active tab, for use as LLM context when generating templates.
 * @module Core/ExtractionEngine
 * @version 1.0.0
 */

import { Logger } from './Logger.js';

export class ExtractionEngine {

  /**
   * Captures sanitised DOM HTML and a base64 screenshot from the given tab.
   * @param {number} tabId
   * @returns {Promise<{ dom: string, screenshotB64: string }>}
   */
  static async capture(tabId) {
    Logger.info('ExtractionEngine', `Capturing tab ${tabId}`);

    const [domResult] = await chrome.scripting.executeScript({
      target : { tabId },
      func   : ExtractionEngine.#extractDom,
    });

    const screenshotB64 = await chrome.tabs.captureVisibleTab(
      null,
      { format: 'png' }
    );

    Logger.info('ExtractionEngine', `Capture complete — DOM ${domResult.result.length} chars`);
    return { dom: domResult.result, screenshotB64 };
  }

  /** @private Runs inside the page context. */
  static #extractDom() {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, svg, canvas, video, audio')
         .forEach((el) => el.remove());
    return clone.outerHTML.slice(0, 80_000);
  }
}
