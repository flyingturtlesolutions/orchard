'use strict';
// bridge/surfaces.cjs — the SURFACE REGISTRY (docs/DESIGN_surfaces.md §2.2/§8, the keystone / unified task runtime).
// A "surface" is an AGENT CONFIG: its altitude (which system prompt the host injects), tool scope (which --settings
// allowlist tier), label, and blurb. The unified runtime spawns BOTH surfaces the same way — as host-managed `claude`
// children, in worktrees, landing through the queue — so they share ONE trust posture: a git-free scoped allowlist,
// never a direct commit. The surface only changes WHAT the agent is told and HOW broad its tools are, never whether it
// can bypass the land gate. The HOST resolves a surface → spawn config; the PANEL offers the list to pick from.
//
// PURE — no host I/O, no spawn. Unit-tested (bridge/surfaces.test.js). Add a surface = one row in SURFACES; the host
// spawn path (K2) + the panel picker (K3) read this registry, so a new surface is data, not a new code path.

// `low`  = the existing dev bridge — implementation altitude (edit code, run tests, land).
// `high` = conceptual / app-level changes — the altitude THIS terminal chat works at, now host-spawned + isolated like
//          `low` instead of committing direct to `main`. Same scoped (git-free) tools; a different system prompt.
const SURFACES = Object.freeze({
  low:  Object.freeze({ id: 'low',  label: 'Dev',    altitude: 'implementation', promptKind: 'dev',  settingsTier: 'scoped', blurb: 'Low-level implementation — edit code, run tests, land changes.' }),
  high: Object.freeze({ id: 'high', label: 'Design', altitude: 'conceptual',     promptKind: 'high', settingsTier: 'scoped', blurb: 'High-level / conceptual — architecture, specs, app-level changes.' }),
});

// The default surface for an unspecified task = today's behavior (a dev / low-level task), so nothing changes until a
// caller explicitly asks for `high`.
const DEFAULT_SURFACE = 'low';

function listSurfaces() { return Object.values(SURFACES); }
function surfaceById(id) { return Object.prototype.hasOwnProperty.call(SURFACES, String(id)) ? SURFACES[String(id)] : null; }
function isSurfaceId(id) { return surfaceById(id) != null; }
// Resolve to a config, defaulting on anything unknown/missing — never throws, so a stale or absent `surface` on a
// conversation record degrades to the dev surface rather than breaking a spawn.
function resolveSurface(id) { return surfaceById(id) || SURFACES[DEFAULT_SURFACE]; }

module.exports = { SURFACES, DEFAULT_SURFACE, listSurfaces, surfaceById, isSurfaceId, resolveSurface };
