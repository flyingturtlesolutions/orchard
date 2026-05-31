// Core/bind.js — SG-4 (Bind), the adapter half. DESIGN §4.4/§SG-4. PURE, NO LLM.
//
// The prove ENGINE already exists (Core/trialSynth.synthesizeTrialOp + the RUN_PERSPECTIVE_TRIAL runner +
// safety classing + scoring). SG-4 doesn't rebuild it — it feeds the Comprehend→Select→Cover output into
// it. This module turns a Select selection (SG-2) into the `roles` bundle synthesizeTrialOp consumes:
//   roles: [{ role, selector, featureId, multiplicity, hidden?, revealedBy? }]
//
// Contract notes that shape this adapter:
//   - synthesizeTrialOp classifies each role by feature.kind (looked up via the locale by featureId), so
//     we always carry featureId — kind comes from the SUBSTRATE, not a guessed name.
//   - reveal sequencing matches a hidden role's `revealedBy` to a TRIGGER's ROLE NAME (not a feature id).
//     The Locale stores revealedBy as a feature id, so we resolve the trigger feature, include it as a
//     role, and rewrite revealedBy to the trigger's role name.
//   - complete intent → roles = the page-required fields (the Cover floor) + the success action.
//     read/act/navigate → roles = the matched features (synth picks reads for EXTRACT, actions for CLICK).
//
// PURE: no DOM/LLM/storage. Unit-testable like the other SG stages.
// @module Core/bind
// @version 2.74.643

import { featureToProtoLandmark } from './landmark.js';
import { resolveIntentGoals } from './select.js';

const _roleName = (f) => (f && typeof f.label === 'string' && f.label.trim()) ? f.label.trim() : (f && f.id) || '';

// v2.74.594 — mirror Core/trialSynth.fillOpFor so the bound role carries its own fill-op token. This
// makes the binding SELF-CONTAINED: a saved capability replays correctly even after the page is
// re-Explored (featureIds are content-hash-derived, so they change and `features[featureId]` would miss).
// synthesizeTrialOp is feature-FIRST, role-fallback, so carrying kind + fieldType reproduces the EXACT
// same bucket (fill vs act) and op (TYPE/SELECT/SET_FILE) the live trial used, with no live feature.
const _fillType = (f) => {
  const ft = (f && f.fieldType) || '';
  const pat = (f && f.interaction && f.interaction.pattern) || '';
  if (ft === 'file' || pat === 'upload') return 'file';
  if (ft === 'select' || pat === 'select') return 'select';
  return 'text';
};
// Annotate a role with the substrate-derived kind + fill-op so it is replayable without the live feature,
// AND a proto-landmark (recoverable identity: selector + role + accessibleName) so the trial/replay can
// probe-or-recover instead of hard-failing on a stale selector (SG-LM-2/3).
const _annotate = (role, f) => {
  if (f && typeof f.kind === 'string' && f.kind) role.kind = f.kind;
  const tok = _fillType(f);
  if (tok === 'file' || tok === 'select') role.fieldType = tok;   // text is the fillOpFor default; omit it
  const lm = featureToProtoLandmark(f, role.fieldType);
  if (lm) role.landmark = lm;
  return role;
};

/**
 * Build the trial `roles` bundle from a Select selection. PURE.
 * @param {object} spec       IntentSpec (SG-1) — uses shape.
 * @param {object} selection  Select output (SG-2): { boundary:{requiredFields,successAction}, matches }.
 * @param {object} [locale]   Locale — to resolve matched featureIds (non-complete) + reveal triggers.
 * @returns {Array<{role:string,selector:string,featureId:string,multiplicity:string,hidden?:boolean,revealedBy?:string}>}
 */
export function selectionToTrialRoles(spec, selection, locale = null) {
  const sel = selection || {};
  const feats = (locale && locale.features && typeof locale.features === 'object') ? locale.features : {};
  const roles = [];
  const seen = new Set();

  const roleFor = (f) => {
    if (!f || !f.selector || seen.has(f.id)) return null;
    const role = _annotate({ role: _roleName(f), selector: f.selector, featureId: f.id, multiplicity: 'one' }, f);
    if (f.hidden) {
      // Resolve the trigger feature and include it FIRST, rewriting revealedBy to its role name so the
      // synth's reveal step can find it (it matches revealedBy === a role name).
      const trig = f.revealedBy ? feats[f.revealedBy] : null;
      if (trig && trig.selector && !seen.has(trig.id)) { seen.add(trig.id); roles.push(_annotate({ role: _roleName(trig), selector: trig.selector, featureId: trig.id, multiplicity: 'one' }, trig)); }
      role.hidden = true;
      role.revealedBy = trig ? _roleName(trig) : null;
    }
    seen.add(f.id);
    return role;
  };
  const push = (f) => { const r = roleFor(f); if (r) roles.push(r); };

  if (spec && spec.shape === 'complete') {
    const b = sel.boundary || {};
    // The page-`required` fields are the completeness FLOOR (the job-APPLICATION case — every field is
    // mandatory). But a "minimal" completion — e.g. a job SEARCH — has target fields that AREN'T HTML-
    // `required`, so the floor alone binds nothing and the plan isn't runnable. v2.74.595 — also bind
    // whatever Select MATCHED to the sub-goals, so the fields the user actually wants filled are always in
    // the plan (UNION of required ∪ matched ∪ success action; `seen` dedups). Don't filter by `required`.
    for (const f of (Array.isArray(b.requiredFields) ? b.requiredFields : [])) push(f);
    const matchedIds = new Set();
    for (const arr of Object.values(sel.matches || {})) for (const id of (Array.isArray(arr) ? arr : [])) matchedIds.add(id);
    for (const id of matchedIds) push(feats[id]);
    if (b.successAction) push(b.successAction);     // the commit; safety class defers it if irreversible
  } else {
    // read / act / navigate — the matched features (resolved via the locale).
    const ids = new Set();
    for (const arr of Object.values(sel.matches || {})) for (const id of (Array.isArray(arr) ? arr : [])) ids.add(id);

    // GOAL-GROUNDED MEMBERSHIP (v2.74.622, SG-RES-7) — the structural fix for the lossy per-sub-goal
    // matcher. It under-binds: for "search for jobs" it returns ONLY the Search submit and drops the
    // q/location inputs, so the trial clicks Search on an EMPTY form and the page reloads to nothing (the
    // live Indeed regression). But the Locale ALREADY groups features by GOAL — ground truth:
    // goal_…sae4d "search for jobs" achievableVia = q ∪ location ∪ Search. So we treat the matcher's output
    // as an ANCHOR, not the membership: any matched feature anchors the goal(s) it belongs to, and we bind
    // the WHOLE goal membership (its inputs + submit + reveal disclosures, non-decoy). A form is an ATOM —
    // you can't bind a goal's submit without its inputs (or an input without its submit) because they arrive
    // together from the goal. Membership comes from the CATALOG; the LLM only says WHICH goal. This
    // generalizes SG-RES-5's submit→inputs special case to anchor-by-any-kind in BOTH directions. Two
    // membership sources, UNIONED so it works whether the Locale carries the forward map, the reverse
    // pointers, or both: forward = locale.goals[g].achievableVia; reverse = features whose f.goals ∋ g.
    // (Scoped to form essentials — inputs + the submit.)
    //
    // NO BLANKET DISCLOSURES (v2.74.633→.635, SG-RES-7e) — a filter PANEL tags many SHARED dropdown
    // disclosures onto EVERY filter goal: Indeed's pay-filter goal listed 7 filter dropdowns (pay, date,
    // job-type, remote, …), and the SAME disclosure ids appear in the date-filter goal too. Expanding them
    // via goal membership opened every dropdown (the live 8-role "Apply pay filter" / 6-role date node). A
    // disclosure's job is to REVEAL hidden content, so it should be bound only when it is the `revealedBy`
    // TRIGGER of a bound hidden feature (roleFor injects exactly that one) or when the matcher ANCHORED it
    // directly (it's in `ids` already, before expansion) — never via blanket goal membership. So
    // _formEssential covers inputs + the submit only; disclosures are reached precisely, not in bulk.
    const goalMap = (locale && locale.goals && typeof locale.goals === 'object') ? locale.goals : {};
    const _formEssential = (f) => !!f && !!f.selector && f.decoy !== true
      && (f.kind === 'input' || (f.kind === 'action' && f.interaction && f.interaction.effect === 'submit'));
    const groundedGoals = new Set();
    for (const id of ids) { const f = feats[id]; if (f && Array.isArray(f.goals)) for (const g of f.goals) groundedGoals.add(g); }
    // ZERO-ANCHOR FALLBACK (v2.74.623, SG-RES-7b / slice 2) — the matcher anchored NO goal (it matched
    // nothing, or only features carrying no goal). Resolve the goal the user NAMED directly off the Locale's
    // goal labels (pure, conservative: abstains on an ambiguous top match) so a goal we can name is still
    // runnable instead of yielding 0 roles. Anchor grounding above is PREFERRED; this only fills the gap
    // when there was none, so it never perturbs the already-working anchored path.
    if (!groundedGoals.size) { for (const g of resolveIntentGoals(locale, spec)) groundedGoals.add(g); }
    if (groundedGoals.size) {
      // ONE INPUT PER ROLE (v2.74.624, SG-RES-7c) — a page can carry two equivalent fields for the same
      // goal: thepetal.com (Shopify) has a visible header search AND a hidden modal search, BOTH labelled
      // "Search". Goal-expanded INPUTS that duplicate an already-bound role are skipped (anchored one wins;
      // distinct roles q + location are all kept).
      //
      // OPTION GROUPS (v2.74.633, SG-RES-7d) — a goal WITHOUT a submit commit is a filter/menu "choose-one":
      // Indeed's pay filter goal = a disclosure + many mutually-exclusive pay brackets ($15+, $20+, …). Its
      // option INPUTS are ALTERNATIVES, not co-requirements — binding all of them made the fragment try to
      // select EVERY bracket (the live 8-role "Apply pay filter" node). So for a no-submit goal we bind at
      // MOST ONE option input (the anchor if present, else the first) PLUS the disclosure to reach it. A goal
      // WITH a submit is a FORM (search/apply) — bind ALL its inputs (you fill every field). Per-goal so the
      // form-vs-filter decision is local to each goal the intent touches.
      const _roleKey = (f) => String((f && (f.label || f.id)) || '').trim().toLowerCase();
      const inputRoles = new Set();
      for (const id of ids) { const f = feats[id]; if (f && f.kind === 'input') inputRoles.add(_roleKey(f)); }
      // REVEAL BOUNDARY (v2.74.642, SG-RES-7f) — a goal-expanded member that's HIDDEN behind a disclosure is
      // bound ONLY if that disclosure is itself anchored, so the operation stays inside ONE dropdown. Indeed's
      // LLM "filter by pay" goal conflated the real Pay-filter brackets with a job-card "missing preference"
      // input (h82vi3) revealed by a DIFFERENT disclosure (2m9dnq); pulling it in dragged the wrong widget into
      // the pay phase and the live run failed. boundDisclosures = matched disclosures ∪ the dropdown each
      // matched hidden anchor lives in (so a matched OPTION still admits its own dropdown's siblings).
      const boundDisclosures = new Set();
      for (const id of ids) { const f = feats[id]; if (!f) continue; if (f.kind === 'disclosure') boundDisclosures.add(id); if (f.hidden && f.revealedBy) boundDisclosures.add(f.revealedBy); }
      for (const g of groundedGoals) {
        // Gather goal g's members from BOTH sources: forward achievableVia ∪ reverse (features whose goals∋g).
        const members = new Map();
        for (const fid of ((goalMap[g] && Array.isArray(goalMap[g].achievableVia)) ? goalMap[g].achievableVia : [])) { if (feats[fid]) members.set(fid, feats[fid]); }
        for (const f of Object.values(feats)) { if (f && Array.isArray(f.goals) && f.goals.includes(g)) members.set(f.id, f); }
        const goalHasSubmit = [...members.values()].some((f) => f.kind === 'action' && f.interaction && f.interaction.effect === 'submit');
        // Has an input of THIS goal already been bound (e.g. the anchored option)?
        let goalInputBound = [...ids].some((id) => { const f = feats[id]; return f && f.kind === 'input' && Array.isArray(f.goals) && f.goals.includes(g); });
        for (const f of members.values()) {
          if (!_formEssential(f)) continue;
          if (f.hidden && f.revealedBy && !boundDisclosures.has(f.revealedBy)) continue;   // SG-RES-7f: behind a DIFFERENT dropdown than the one we're operating
          if (f.kind === 'input') {
            if (!goalHasSubmit && goalInputBound) continue;             // SG-RES-7d: option group → at most one input
            const k = _roleKey(f); if (inputRoles.has(k)) continue;     // SG-RES-7c: one per distinct role
            inputRoles.add(k); if (!goalHasSubmit) goalInputBound = true;
          }
          ids.add(f.id);
        }
      }
    }

    // CONTAINER → ONE OPTION (v2.74.643, SG-RES-7g) — a filter dropdown's selectable VALUES are its
    // individual options, but the matcher often anchors the LISTBOX/MENU CONTAINER whose accName concatenates
    // every option ("All Dates Last 24 hours Last 7 days…"). Clicking the container applies the dropdown's
    // DEFAULT, not a chosen value — and some widgets don't even resolve the container at runtime (Indeed's
    // Pay "Pay options" listbox). The reveal pass captures each option as its OWN feature (a11yRole 'option',
    // revealedBy the same trigger), so when a bound feature is a container and a concrete option child exists,
    // swap the container for one option — IN PLACE so step order (open → choose → commit) is preserved. Prefer
    // a non-default value ("All…/Any…/Clear" are no-ops). No child in the catalog → keep the container (open +
    // default still applies, no regression). The per-phase role log surfaces the swap (option id, not the ul).
    {
      const _role = (f) => String((f && f.a11yRole) || '').toLowerCase().trim();
      const CONTAINER_ROLES = new Set(['listbox', 'menu', 'menubar', 'group', 'radiogroup', 'tree', 'grid', 'combobox']);
      const OPTION_ROLES = new Set(['option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'radio', 'checkbox', 'treeitem', 'tab']);
      const _isDefaultLabel = (s) => /^(all\b|any\b|none\b|clear|reset|default|no\s+(min|max|pref))/i.test(String(s || '').trim());
      const ordered = [...ids];
      const bound = new Set(ordered);
      for (let i = 0; i < ordered.length; i++) {
        const cont = feats[ordered[i]];
        if (!cont || !CONTAINER_ROLES.has(_role(cont)) || !cont.revealedBy) continue;
        const trig = cont.revealedBy;
        const siblings = Object.values(feats).filter((f) => f && f.id !== cont.id && !bound.has(f.id)
          && f.selector && f.decoy !== true && f.revealedBy === trig
          && !(f.interaction && f.interaction.effect === 'submit') && !CONTAINER_ROLES.has(_role(f)));
        const concrete = siblings.filter((f) => !_isDefaultLabel(f.label));
        const pool = concrete.length ? concrete : siblings;
        const child = pool.find((f) => OPTION_ROLES.has(_role(f))) || pool[0];
        if (child) { bound.delete(cont.id); bound.add(child.id); ordered[i] = child.id; }
      }
      ids.clear(); for (const id of ordered) ids.add(id);
    }

    for (const id of ids) push(feats[id]);
    // If the intent FILLS a form (matched ≥1 input) it must also SUBMIT to surface a result — but "submit"
    // isn't a phase the matcher names, so a search trial otherwise types the query and EXTRACTs an
    // UNSUBMITTED page (no results, no search button). Bind the effect:submit control that shares a GOAL
    // with a filled input — goal membership scopes it to the SAME form when the page has several submits.
    // Skip if a submit was already matched. (The `complete` branch binds the success action explicitly.)
    const filledInputIds = [...ids].filter((id) => feats[id] && feats[id].kind === 'input');
    const alreadyHasSubmit = [...ids].some((id) => feats[id] && feats[id].kind === 'action' && feats[id].interaction && feats[id].interaction.effect === 'submit');
    if (filledInputIds.length && !alreadyHasSubmit) {
      const filledGoals = new Set();
      for (const id of filledInputIds) for (const g of (feats[id].goals || [])) filledGoals.add(g);
      const submits = Object.values(feats).filter((f) => f && f.kind === 'action' && f.interaction && f.interaction.effect === 'submit' && f.selector && f.decoy !== true);
      let submit = submits.find((f) => (f.goals || []).some((g) => filledGoals.has(g)));
      if (!submit && submits.length === 1) submit = submits[0];   // unambiguous page-single submit
      if (submit) push(submit);
    }
  }
  return roles;
}
