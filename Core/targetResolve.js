// TRT-2 (v2.74.1546, DESIGN_target_routing.md §3) — the TARGET RESOLVER: one pure, ordered ladder answering
// "WHERE does this ask run?" — the stage every 2026-07 routing failure was missing. TR-0 (deterministic command
// shapes) is claimed by the chat's intercepts BEFORE this runs; the ladder starts at TR-1. The resolver names the
// TARGET; it never grants run authority (ORCH-G's auto/confirm gate is unchanged) and never guesses between real
// alternatives (ambiguity → candidates → the user picks). Every decision is one explainable line:
// `TARGET ▸ tier=… target=… why=…`. PURE — all data injected; no chrome.*, no storage, no LLM.

import { contentTokens, scoreAskAffinity } from './groundVocabulary.js';

// Tokens after a destination preposition that are NOT site names (mirrors orchChain's _SITE_STOP — kept local so
// this module stays dependency-light and the two lists can drift apart deliberately if the use cases diverge).
const _SITE_STOP = new Set(['it', 'me', 'them', 'us', 'you', 'the', 'a', 'an', 'my', 'your', 'our', 'their',
  'his', 'her', 'this', 'that', 'these', 'those', 'here', 'there', 'home', 'top', 'bottom', 'left', 'right',
  'one', 'each', 'every', 'all', 'both', 'page', 'site', 'list', 'side', 'end', 'start', 'tab', 'browser', 'web',
  'case', 'cases', 'desk', 'new']);

/** Site-ish tokens the ask names after a destination preposition ("on vendorsuite", "at zendesk"). PURE. */
export function siteRefTokens(ask) {
  const re = /\b(?:on|onto|in|into|at|from|to)\s+([a-z][a-z0-9.&'-]{2,})/ig;
  const out = []; const seen = new Set();
  let m;
  while ((m = re.exec(String(ask || ''))) !== null) {
    const tok = m[1].toLowerCase();
    if (_SITE_STOP.has(tok) || seen.has(tok)) continue;
    seen.add(tok); out.push(tok);
  }
  return out;
}

// Does a named token identify this ground? Host-contains ("vendorsuite" ⊂ vendorsuite.drhorton.com) or
// name-contains, both case-insensitive. KNOWN grounds only — a token matching nothing is IGNORED (never minted,
// never a teach-trigger by itself: "on monday" must not gap an otherwise-resolvable ask).
function _groundForToken(tok, grounds) {
  for (const g of grounds) {
    const host = String(g.host || '').toLowerCase();
    const name = String(g.name || '').toLowerCase();
    if ((host && host.includes(tok)) || (name && tok.length >= 4 && name.includes(tok))) return g;
  }
  return null;
}

const _hostIn = (host, origins) => !!host && (origins || []).some((o) => String(o || '').toLowerCase() === String(host).toLowerCase());

/**
 * Resolve an ask's TARGET over injected library data. Ladder: TR-1 explicit → TR-2 conversation (desk; an
 * exact alias WITHIN the desk keeps its auto authority) → TR-3 exact alias (global) → TR-4 focused tab →
 * TR-5 live sessions → TR-6 global affinity → TR-7 teach.
 * @param {string} ask
 * @param {{
 *   grounds: Array<{groundId:string, host:string, name?:string}>,
 *   fingerprints?: Array<{groundId:string, fp:Object}>,          // groundVocabulary.vocabularyFingerprint
 *   aliasIndex?: Array<{phrase:string, groundId:string, capabilityId:string}>,  // phrases PRE-normalized
 *   normalizePhrase?: (s:string)=>string,                        // the SAME normalizer that built aliasIndex
 *   deskOrigins?: string[],                                      // the conversation's bound connections (TR-2)
 *   tabGroundId?: (string|null),                                 // TR-4
 *   liveOrigins?: string[],                                      // fresh-session / open-tab origins (TR-5)
 * }} ctx
 * @returns {{tier:string, tr:number, groundId?:string, host?:string, capabilityId?:string, auto?:boolean,
 *            visitor?:boolean, why:string, matchedTerms?:string[], candidates?:Array}}
 */
export function resolveTarget(ask, ctx = {}) {
  const grounds = (Array.isArray(ctx.grounds) ? ctx.grounds : []).filter((g) => g && g.groundId);
  const byId = new Map(grounds.map((g) => [g.groundId, g]));
  const fps = Array.isArray(ctx.fingerprints) ? ctx.fingerprints : [];
  const deskOrigins = (Array.isArray(ctx.deskOrigins) ? ctx.deskOrigins : []).filter(Boolean);
  const tokens = contentTokens(ask);
  const _visitor = (host) => (deskOrigins.length > 0 && !_hostIn(host, deskOrigins)) || undefined;
  const _pick = (tier, tr, g, extra = {}) => ({ tier, tr, groundId: g.groundId, host: g.host, visitor: _visitor(g.host), ...extra });

  // ── TR-1 EXPLICIT — the ask names a KNOWN ground. Authoritative; visitor-flagged when off-desk. ──
  for (const tok of siteRefTokens(ask)) {
    const g = _groundForToken(tok, grounds);
    if (g) return _pick('explicit', 1, g, { why: `named "${tok}"` });
  }

  // Alias lookup (used by TR-2a and TR-3) — exact normalized phrase.
  let aliasHit = null;
  if (Array.isArray(ctx.aliasIndex) && ctx.aliasIndex.length && typeof ctx.normalizePhrase === 'function') {
    const n = ctx.normalizePhrase(ask);
    aliasHit = ctx.aliasIndex.find((a) => a && a.phrase === n && byId.has(a.groundId)) || null;
  }

  // ── TR-2 CONVERSATION — the desk's bound connections outrank the tab. ──
  if (deskOrigins.length) {
    const deskGrounds = grounds.filter((g) => _hostIn(g.host, deskOrigins));
    // TR-2a — an exact alias WITHIN the desk keeps its full (auto) authority: the taught phrase is prior consent,
    // and the desk already scopes it. (Ordering note in the spec: alias sits below conversation, but an alias
    // whose ground IS a desk connection satisfies both tiers at once.)
    if (aliasHit) {
      const ag = byId.get(aliasHit.groundId);
      if (ag && _hostIn(ag.host, deskOrigins)) return _pick('alias', 3, ag, { capabilityId: aliasHit.capabilityId, auto: true, why: 'alias-in-desk' });
    }
    if (deskGrounds.length) {
      const ranked = scoreAskAffinity(tokens, fps.filter((f) => deskGrounds.some((g) => g.groundId === f.groundId)));
      if (ranked.length) {
        const top = ranked[0];
        return _pick('conversation', 2, byId.get(top.groundId), { why: `desk affinity (${top.matchedTerms.join(', ')})`, matchedTerms: top.matchedTerms });
      }
      // Desk grounds exist but none speak the ask's vocabulary → fall through (the §5.4 inverse case).
    }
  }

  // ── TR-3 EXACT MEMORY — the taught phrase runs where taught; AUTO. Visitor when off-desk. ──
  if (aliasHit) {
    const ag = byId.get(aliasHit.groundId);
    if (ag) return _pick('alias', 3, ag, { capabilityId: aliasHit.capabilityId, auto: true, why: 'alias-exact' });
  }

  // ── TR-4 FOCUSED TAB — the present-tense signal. ──
  if (ctx.tabGroundId && byId.has(ctx.tabGroundId)) {
    const g = byId.get(ctx.tabGroundId);
    // Attach the global affinity leader for the trace line (shadow insight — a strongly-scoring elsewhere is
    // exactly the disagreement worth logging), without changing the pick (conservative: tab claims).
    const ranked = scoreAskAffinity(tokens, fps);
    const alt = ranked.length && ranked[0].groundId !== g.groundId ? ranked[0] : null;
    return _pick('tab', 4, g, { why: 'focused tab', ...(alt ? { altAffinity: { groundId: alt.groundId, matchedTerms: alt.matchedTerms } } : {}) });
  }

  // ── TR-5 LIVE SESSIONS — fresh-session/open-tab origins with vocabulary affinity. ──
  const liveOrigins = (Array.isArray(ctx.liveOrigins) ? ctx.liveOrigins : []).filter(Boolean);
  if (liveOrigins.length) {
    const liveGrounds = grounds.filter((g) => _hostIn(g.host, liveOrigins));
    const ranked = scoreAskAffinity(tokens, fps.filter((f) => liveGrounds.some((g) => g.groundId === f.groundId)));
    if (ranked.length === 1 || (ranked.length > 1 && ranked[0].score >= ranked[1].score * 2)) {
      const top = ranked[0];
      return _pick('live', 5, byId.get(top.groundId), { why: `live session + affinity (${top.matchedTerms.join(', ')})`, matchedTerms: top.matchedTerms });
    }
    if (ranked.length > 1) {
      return { tier: 'live', tr: 5, why: 'ambiguous among live sessions', candidates: ranked.slice(0, 3).map((r) => ({ groundId: r.groundId, host: (byId.get(r.groundId) || {}).host, matchedTerms: r.matchedTerms })) };
    }
  }

  // ── TR-6 GLOBAL — all grounds ranked by affinity; 1 → confirm, ≥2 → pick. ──
  {
    const ranked = scoreAskAffinity(tokens, fps);
    if (ranked.length === 1 || (ranked.length > 1 && ranked[0].score >= ranked[1].score * 2)) {
      const top = ranked[0];
      return _pick('global', 6, byId.get(top.groundId), { why: `global affinity (${top.matchedTerms.join(', ')})`, matchedTerms: top.matchedTerms });
    }
    if (ranked.length > 1) {
      return { tier: 'global', tr: 6, why: 'ambiguous globally', candidates: ranked.slice(0, 3).map((r) => ({ groundId: r.groundId, host: (byId.get(r.groundId) || {}).host, matchedTerms: r.matchedTerms })) };
    }
  }

  // ── TR-7 TEACH — no target can serve the content. ──
  return { tier: 'teach', tr: 7, why: 'no target speaks this ask' };
}

/** Render the decision as the one-line trace (§7.3): `tier=… target=… why=…`. PURE. */
export function renderTargetDecision(d, { shadow = false } = {}) {
  if (!d) return 'TARGET ▸ (none)';
  const parts = [`tier=TR-${d.tr}/${d.tier}`, `target=${d.host || d.groundId || (d.candidates ? d.candidates.map((c) => c.host || c.groundId).join('|') : '—')}`, `why=${d.why}`];
  if (d.auto) parts.push('auto');
  if (d.visitor) parts.push('visitor');
  if (d.altAffinity) parts.push(`alt=${d.altAffinity.groundId}(${(d.altAffinity.matchedTerms || []).join(',')})`);
  return `TARGET ▸ ${shadow ? '(shadow) ' : ''}${parts.join(' ')}`;
}
