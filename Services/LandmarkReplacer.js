/**
 * @file Services/LandmarkReplacer.js
 * @description Phase 10 of the landmark substrate spec. Symmetric
 * counterpart to Phase 5's LandmarkImpactAnalysis: where impact
 * analysis ANSWERS "what would break if I removed this landmark?",
 * the replacer EXECUTES "rewrite every reference to landmark A so it
 * points at landmark B instead." Together they implement the spec's
 * reference-integrity workflow per § Reference integrity:
 *
 *   "Either: replace references with another landmark, or accept
 *    that those primitives become broken."
 *
 * Until this module, only the second path existed in code — authors
 * could see warnings on landmark deletion but had no automated way
 * to rewire downstream consumers. They had to manually re-author each
 * fragment / observation / perspective.
 *
 * ── WHAT GETS REWRITTEN ──────────────────────────────────────────────
 *
 *   Perspectives — `landmarkRefs[]` entries where ref === oldUid are
 *             replaced with newUid (dedupe if newUid already present).
 *             Legacy `landmarks[]` embedded records are NOT mutated
 *             — those are realization-bearing data the spec treats as
 *             pre-substrate, and rewriting them is destructive in a
 *             way landmarkRefs replacement isn't. Skipped refs are
 *             reported in `changes.skipped[]`.
 *
 *   Fragments — `rawJson` is parsed, walked (top-level + chain
 *             branches + gate body subs), and every
 *             `action.landmarkRef.uid === oldUid` is rewritten to
 *             newUid. Legacy `{ perspectiveId, role }` refs are SKIPPED:
 *             the role-to-uid association is perspective-scoped and may
 *             mean different things in different perspectives — rewriting
 *             blindly is unsafe. Each rewrite re-serializes the
 *             rawJson and calls updateFragment().
 *
 *   Observations — same walk semantics as fragments but on extracts[]
 *             (and extract_gate body[] sub-extracts). Saved via
 *             saveObservation() (whole-record write; no updateObs API).
 *
 * ── SAFETY ──────────────────────────────────────────────────────────
 *
 * - Pre-flight checks BEFORE any writes: both UIDs exist, both on
 *   the same ground, and oldUid !== newUid.
 * - Role / a11yRole mismatch between old and new is permitted but
 *   surfaced in the return as `rolePresentMismatch: true`. Decision:
 *   warn-only, not block — author may be deliberately swapping roles
 *   (e.g., recategorizing a misclassified landmark). Studio will
 *   surface the warning before commit.
 * - `dryRun: true` returns the exact changes that WOULD be made
 *   without writing. Used by Studio for "preview replacement" UX.
 * - Per-record write failures don't roll back prior writes (MV3
 *   chrome.storage has no transactions). All failures collect into
 *   `errors[]` so the caller can retry the failed subset.
 *
 * @module Services/LandmarkReplacer
 */

import { StorageManager } from './StorageManager.js';
import { Logger }         from '../Core/Logger.js';

/**
 * Rewrite landmarkRef.uid in an actions tree, returning a deep-cloned
 * tree with rewrites applied + a count of rewrites. Pure function.
 *
 * Walks: top-level actions; action.branches[] (chains); action.body[]
 * (gate bodies). Modern `{ uid }` refs only — legacy `{ perspectiveId,
 * role }` refs are left untouched (see module header rationale).
 *
 * @param {Array} actions
 * @param {string} oldUid
 * @param {string} newUid
 * @returns {{ rewritten: Array, count: number }}
 */
// v2.74.275 — Legacy ref tracking REMOVED. Only canonical { uid }
// refs exist after the legacy-shape cleanup; skippedLegacyRefs field
// is gone from return shape (consumers updated).
function _rewriteActions(actions, oldUid, newUid) {
  if (!Array.isArray(actions)) return { rewritten: actions, count: 0 };
  let count = 0;
  const out = [];
  for (const a of actions) {
    if (!a || typeof a !== 'object') { out.push(a); continue; }
    const clone = { ...a };
    if (clone.landmarkRef && clone.landmarkRef.uid === oldUid) {
      clone.landmarkRef = { ...clone.landmarkRef, uid: newUid };
      count++;
    }
    if (Array.isArray(clone.branches)) {
      const sub = _rewriteActions(clone.branches, oldUid, newUid);
      clone.branches = sub.rewritten;
      count += sub.count;
    }
    if (Array.isArray(clone.body)) {
      const sub = _rewriteActions(clone.body, oldUid, newUid);
      clone.body = sub.rewritten;
      count += sub.count;
    }
    out.push(clone);
  }
  return { rewritten: out, count };
}

function _rewriteExtracts(extracts, oldUid, newUid) {
  if (!Array.isArray(extracts)) return { rewritten: extracts, count: 0 };
  let count = 0;
  const out = [];
  for (const ex of extracts) {
    if (!ex || typeof ex !== 'object') { out.push(ex); continue; }
    const clone = { ...ex };
    if (clone.landmarkRef && clone.landmarkRef.uid === oldUid) {
      clone.landmarkRef = { ...clone.landmarkRef, uid: newUid };
      count++;
    }
    if (Array.isArray(clone.body)) {
      const sub = _rewriteExtracts(clone.body, oldUid, newUid);
      clone.body = sub.rewritten;
      count += sub.count;
    }
    out.push(clone);
  }
  return { rewritten: out, count };
}

/**
 * Replace every reference to oldUid with newUid across all consumers
 * on a Ground. Both UIDs must exist in the registry and be on the
 * same Ground.
 *
 * @param {string} oldUid
 * @param {string} newUid
 * @param {string} groundId
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {Promise<{
 *   success: boolean,
 *   oldUid: string,
 *   newUid: string,
 *   groundId: string,
 *   dryRun: boolean,
 *   rolePresentMismatch: boolean,
 *   roleOld?: string,
 *   roleNew?: string,
 *   a11yRoleOld?: string,
 *   a11yRoleNew?: string,
 *   changes: {
 *     perspectives: Array<{id, name, refsRewritten, alreadyHadNew}>,
 *     fragments: Array<{id, name, refsRewritten}>,
 *     observations: Array<{id, name, refsRewritten}>,
 *     skipped: Array<{kind, id, reason}>,
 *   },
 *   totals: {
 *     perspectivesRewritten: number,
 *     fragmentsRewritten: number,
 *     observationsRewritten: number,
 *     totalRefsRewritten: number,
 *   },
 *   errors: Array<{kind, id, error}>,
 * }>}
 */
export async function replaceLandmarkReferences(oldUid, newUid, groundId, opts = {}) {
  const dryRun = opts.dryRun === true;

  const baseResult = {
    success: false,
    oldUid, newUid, groundId,
    dryRun,
    // v2.74.275 — Field renamed: rolePresentMismatch → aliasPresentMismatch.
    // Tracks divergence in the author-typed alias (formerly `role`) +
    // a11yRole between old and new landmarks.
    aliasPresentMismatch: false,
    changes: { perspectives: [], fragments: [], observations: [], skipped: [] },
    totals: {
      perspectivesRewritten: 0, fragmentsRewritten: 0, observationsRewritten: 0,
      totalRefsRewritten: 0,
    },
    errors: [],
  };

  // ── Pre-flight validation ─────────────────────────────────────────
  if (!oldUid || !newUid || !groundId) {
    return { ...baseResult, error: 'oldUid + newUid + groundId all required' };
  }
  if (oldUid === newUid) {
    return { ...baseResult, error: 'oldUid and newUid are the same' };
  }

  const [oldLm, newLm] = await Promise.all([
    StorageManager.getLandmark(oldUid).catch(() => null),
    StorageManager.getLandmark(newUid).catch(() => null),
  ]);
  if (!oldLm) return { ...baseResult, error: `oldUid ${oldUid} not in registry` };
  if (!newLm) return { ...baseResult, error: `newUid ${newUid} not in registry` };
  if (oldLm.groundId !== groundId) {
    return { ...baseResult, error: `oldUid belongs to ground ${oldLm.groundId}, not ${groundId}` };
  }
  if (newLm.groundId !== groundId) {
    return { ...baseResult, error: `newUid belongs to ground ${newLm.groundId}, not ${groundId}` };
  }

  // v2.74.275 — Renamed result fields: roleOld/roleNew → aliasOld/aliasNew.
  baseResult.aliasOld     = oldLm.alias ?? null;
  baseResult.aliasNew     = newLm.alias ?? null;
  baseResult.a11yRoleOld  = oldLm.a11yRole ?? null;
  baseResult.a11yRoleNew  = newLm.a11yRole ?? null;
  // Surface alias / a11yRole mismatch but do not block — author may be
  // deliberately recategorizing. UI displays the warning before commit.
  const equal = (a, b) => (a ?? null) === (b ?? null);
  baseResult.aliasPresentMismatch = !equal(oldLm.alias, newLm.alias)
                                 || !equal(oldLm.a11yRole, newLm.a11yRole);

  // ── Perspectives: rewrite landmarkRefs[]; preserve legacy landmarks[] ──
  try {
    const allPerspectives = await StorageManager.listPerspectives(groundId);
    for (const perspective of allPerspectives ?? []) {
      const refs = Array.isArray(perspective.landmarkRefs) ? perspective.landmarkRefs : null;
      if (refs && refs.includes(oldUid)) {
        const alreadyHadNew = refs.includes(newUid);
        // Replace oldUid with newUid; dedupe (preserve first
        // occurrence position).
        const seen = new Set();
        const newRefs = [];
        for (const r of refs) {
          const mapped = r === oldUid ? newUid : r;
          if (seen.has(mapped)) continue;
          seen.add(mapped);
          newRefs.push(mapped);
        }
        const refsRewritten = refs.filter(r => r === oldUid).length;
        // v2.74.261 — BUG FIX: only increment totals after successful
        // write in commit mode. Previously, totals were incremented
        // BEFORE the write attempt — a failed write would land in
        // errors[] but the totals would still claim it succeeded.
        // dryRun path counts unconditionally (no write to fail).
        let writeOk = true;
        if (!dryRun) {
          try {
            await StorageManager.updatePerspective(perspective.id, { landmarkRefs: newRefs });
          } catch (e) {
            writeOk = false;
            baseResult.errors.push({ kind: 'perspective', id: perspective.id, error: e.message });
          }
        }
        if (writeOk || dryRun) {
          baseResult.changes.perspectives.push({
            id            : perspective.id,
            name          : perspective.name ?? perspective.id,
            refsRewritten,
            alreadyHadNew,
          });
          baseResult.totals.perspectivesRewritten++;
          baseResult.totals.totalRefsRewritten += refsRewritten;
        }
      }
      // v2.74.275 — Legacy embedded landmarks[] detection REMOVED.
      // Embedded shape no longer supported; perspectives use landmarkRefs[] only.
    }
  } catch (e) {
    Logger.warn('LandmarkReplacer', `listPerspectives failed: ${e.message}`);
    baseResult.errors.push({ kind: 'perspectives-scan', id: groundId, error: e.message });
  }

  // ── Fragments: walk rawJson, rewrite uid refs ─────────────────────
  try {
    const allFragments = await StorageManager.listFragments(groundId);
    for (const frag of allFragments ?? []) {
      let actions;
      try {
        actions = typeof frag.rawJson === 'string'
          ? JSON.parse(frag.rawJson)
          : (Array.isArray(frag.rawJson) ? frag.rawJson : []);
      } catch {
        // Unparseable rawJson — skip with note.
        baseResult.changes.skipped.push({
          kind: 'fragment', id: frag.id, reason: 'rawJson unparseable',
        });
        continue;
      }
      const { rewritten, count } = _rewriteActions(actions, oldUid, newUid);
      if (count > 0) {
        let writeOk = true;
        if (!dryRun) {
          try {
            await StorageManager.updateFragment(frag.id, { rawJson: JSON.stringify(rewritten) });
          } catch (e) {
            writeOk = false;
            baseResult.errors.push({ kind: 'fragment', id: frag.id, error: e.message });
          }
        }
        if (writeOk || dryRun) {
          baseResult.changes.fragments.push({
            id: frag.id, name: frag.name ?? frag.id, refsRewritten: count,
          });
          baseResult.totals.fragmentsRewritten++;
          baseResult.totals.totalRefsRewritten += count;
        }
      }
    }
  } catch (e) {
    Logger.warn('LandmarkReplacer', `listFragments failed: ${e.message}`);
    baseResult.errors.push({ kind: 'fragments-scan', id: groundId, error: e.message });
  }

  // ── Observations: walk extracts[], rewrite uid refs ───────────────
  try {
    const allObs = await StorageManager.listObservations(groundId);
    for (const obs of allObs ?? []) {
      const extracts = Array.isArray(obs.extracts) ? obs.extracts : [];
      const { rewritten, count } = _rewriteExtracts(extracts, oldUid, newUid);
      if (count > 0) {
        let writeOk = true;
        if (!dryRun) {
          try {
            const updated = { ...obs, extracts: rewritten };
            await StorageManager.saveObservation(updated);
          } catch (e) {
            writeOk = false;
            baseResult.errors.push({ kind: 'observation', id: obs.id, error: e.message });
          }
        }
        if (writeOk || dryRun) {
          baseResult.changes.observations.push({
            id: obs.id, name: obs.name ?? obs.id, refsRewritten: count,
          });
          baseResult.totals.observationsRewritten++;
          baseResult.totals.totalRefsRewritten += count;
        }
      }
    }
  } catch (e) {
    Logger.warn('LandmarkReplacer', `listObservations failed: ${e.message}`);
    baseResult.errors.push({ kind: 'observations-scan', id: groundId, error: e.message });
  }

  baseResult.success = true;
  if (!dryRun) {
    Logger.info('LandmarkReplacer',
      `replaceLandmarkReferences ${oldUid} → ${newUid} on ${groundId}: ` +
      `${baseResult.totals.perspectivesRewritten} perspective(s), ` +
      `${baseResult.totals.fragmentsRewritten} fragment(s), ` +
      `${baseResult.totals.observationsRewritten} observation(s), ` +
      `${baseResult.totals.totalRefsRewritten} refs rewritten, ` +
      `${baseResult.errors.length} error(s)`
    );
  }
  return baseResult;
}
