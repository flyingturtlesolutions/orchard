// Core/synthFromGap.js — synthesize a durable, UNVERIFIED capability from a harvested gap (PS-3, v2.74.1126).
//
// "Stage, verify-on-first-use." A harvested gap (PS-1) is a one-action demonstration — the user already clicked
// the control and we captured its a11y identity. Given a freshly-RESOLVED selector (from probe-or-recover),
// compose the SAME library entities the OBS demonstration path produces — Landmark + Perspective + Fragment +
// Capability — but marked `trial.verdict:'observed'` (selector-proven, behaviour-UNVERIFIED) + `source:'harvested'`.
// NO trial, no faked verdict, no live click: the FIRST real invocation is the actual click, gated by the existing
// read-only-floor / write-confirm. Identity-only (value-free, §5).
//
// PURE: composes via accept.js's pure builders, with `now` + `newId` injected (no Date.now / crypto here). The
// I/O — probe for the selector, persist the entities, flip the gap to 'promoted' — is the handler's job. Scoped to
// the single-click case (one control, no params, no navigation); multi-step synthesis stays on the OBS path.

import { buildLandmarkRecords, buildPerspectiveRecord, landmarkRefActions } from './accept.js';

/**
 * Build the library entities for a harvested single-click gap. PURE.
 * @param {{gap:object, selector:string, localeUrl:string, groundId:string}} args
 *   gap.fulfillment = {role, accessibleName, tagName} (captured at harvest, PS-1)
 * @param {{now?:number, newId?:()=>string}} deps  injected timestamp + id generator
 * @returns {{landmarks:Array<object>, perspective:object, fragment:object, capability:object}|null}
 */
export function buildHarvestCapability({ gap, selector, localeUrl = '', groundId } = {}, { now = 0, newId = () => 'id' } = {}) {
  const f = gap && gap.fulfillment;
  if (!gap || !groundId || !selector || !f || !f.accessibleName) return null;
  const intent = String(gap.intent || f.accessibleName).slice(0, 80);
  // Native controls (a YouTube <button>) capture NO explicit aria role → fall back to Orchard's enumerated guess
  // (expectedIdentity.role) so probe-or-recover has a role to recover by, both now and on replay.
  const role = f.role || (gap.expectedIdentity && gap.expectedIdentity.role) || null;
  const landmark = { role, accessibleName: f.accessibleName, selector, hierarchicalContext: null };

  // Mint the durable Landmark (same builder the OBS accept uses). 'fresh' + 'harvested' — selector-proven, NOT
  // 'verified' (a demonstration is its own verification; a harvest's BEHAVIOUR isn't proven until first run).
  const recs = buildLandmarkRecords({ roles: [{ role: f.accessibleName, landmark }], groundId, localeUrl });
  if (!recs.length) return null;
  const { uid, record } = recs[0];
  record.lifecycle = 'fresh'; record.source = 'harvested'; record.createdAt = now;

  const perspective = buildPerspectiveRecord({ intent, spec: { shape: 'observed', target: intent }, groundId, localeUrl, landmarkUids: [uid] });

  // The 1-step Fragment — landmarkRefActions rewrites the inline landmark to a registry `landmarkRef` (the same
  // uid the record carries), so replay recovers via the registry (probe-or-recover), not a frozen selector.
  const fragmentId = newId();
  const actions = landmarkRefActions([{ action: 'CLICK', selector, landmark }], groundId, localeUrl);
  const fragment = {
    id: fragmentId, groundId, name: intent, description: intent, kind: 'action',
    actions,
    preconditions: [{ type: 'perspective_ref', perspectiveId: perspective.id, advisory: true }],
    postconditions: [],                                   // a bare action has no observable success signal yet
    lifecycle: 'fresh', createdAt: now,
  };

  // The matcher-facing Capability — mirrors the OBS-derived shape, but UNVERIFIED: trial.verdict:'observed'
  // (the matcher downranks it vs trial-pass'd caps) and source:'harvested'.
  const capability = {
    id: newId(), groundId, intent, description: intent,
    shape: 'observed', source: 'harvested',
    localeUrl, perspectiveId: perspective.id,
    fragmentId, fragmentIds: [fragmentId], landmarkUids: [uid],
    params: [], aliases: [], phases: [intent], binding: [],
    synthesized: true, createdAt: now,
    trial: { score: null, verdict: 'observed', trialRef: null },
  };

  return { landmarks: [record], perspective, fragment, capability };
}
