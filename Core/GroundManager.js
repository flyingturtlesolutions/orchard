/**
 * @file Core/GroundManager.js
 * @description Business-logic layer for Ground CRUD. Delegates persistence to
 * StorageManager and enforces domain rules (e.g. URL validation).
 * @module Core/GroundManager
 * @version 1.0.0
 */

import { Logger }         from './Logger.js';
import { StorageManager } from '../Services/StorageManager.js';

export class GroundManager {

  /**
   * Creates and persists a new Ground (GROUND_SPEC § 6 shape).
   * Accepts `name` (canonical) or legacy `aiName`. saveGround normalizes
   * the record (builds urlPatterns[] from `url`, sets the deprecated
   * name/url mirrors); we return the normalized + perspectiveIds-projected
   * record via getGround.
   * @param {{ name?: string, aiName?: string, url: string }} params
   * @returns {Promise<import('../Services/StorageManager.js').Ground>}
   */
  static async create({ name, aiName, url }) {
    new URL(url); // throws if invalid
    const displayName = (name ?? aiName ?? '').trim();
    const now = Date.now();
    const ground = {
      // v2.74.325 — new grounds get the spec `gnd_` prefix; existing ids
      // are intentionally NOT re-keyed (see StorageManager #normalizeGroundRecord).
      id       : `gnd_${crypto.randomUUID()}`,
      name     : displayName,
      url      : url.trim(),
      metadata : { createdAt: now, updatedAt: now, lifecycle: 'draft' },
    };
    await StorageManager.saveGround(ground);
    Logger.info('GroundManager', `Created ground "${displayName}" (${ground.id})`);
    return StorageManager.getGround(ground.id);
  }

  /** @returns {Promise<import('../Services/StorageManager.js').Ground[]>} */
  static getAll() { return StorageManager.getAllGrounds(); }

  /** @param {string} id @returns {Promise<import('../Services/StorageManager.js').Ground|null>} */
  static get(id) { return StorageManager.getGround(id); }

  /**
   * @param {string} id
   * @param {{ aiName?: string, url?: string }} patch
   */
  static update(id, patch) { return StorageManager.updateGround(id, patch); }

  /** @param {string} id */
  static delete(id) { return StorageManager.deleteGround(id); }
}
