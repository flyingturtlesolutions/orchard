# RESEARCH — Session keep-alive / logout prevention (2026-08-07)

Deep-research pass (106 agents, 24 sources, 119 claims → 25 verified → 20 confirmed after 2-of-3 adversarial
verification). Feeds the SGV keep-alive/heal rungs (docs/DESIGN_session_governor.md §2/§4). Vendor numbers are
DEFAULTS — configurable per tenant; probe, never assume.

## The governing distinction

Sessions die on two orthogonal axes; **only one is extendable.**

| Class | Reset by | Extendable? |
|---|---|---|
| Idle / sliding timeout | activity (server-observed request, or a refresh-token exchange) | YES — in principle indefinitely |
| Absolute / maximum lifetime | nothing — counts from creation | **NO** — every keep-alive technique is immune; ends only in re-auth |

OWASP absolute timeout, Auth0 "Require log in after," IdentityServer `AbsoluteRefreshTokenLifetime` are all the
immune class. **SGV rung 1 can defeat rot, never a hard expiry.** Any copy that promises "stays logged in" lies
about the absolute class.

## What counts as "activity" (CONFIRMED, with the caveat that matters)

- Idle timers are measured **server-side, from the last HTTP request received** — NOT from real user input.
  A background request the server counts as activity resets the timer (OWASP). This is the canary mechanism.
- **CAVEAT (verifier-enforced):** request-based reset is the dominant default, NOT universal — some apps use
  client-side input timers; Django doesn't refresh expiry per request by default. **A ping refreshing a given
  site's idle timer MUST be probed per site.** (The pass could NOT confirm Zendesk/Shopify specifically.)
- Timeout enforcement is **server-side**, so `chrome.cookies` manipulation is useless for freshness — only
  server-observed requests (or a token exchange) move the needle. (Validates SGV never touching cookies.)

## The MV3 extension is unusually well-positioned (the strong result)

- **Host-permissioned background fetches are treated SAME-SITE** — they carry the user's full session cookies
  including `SameSite=Strict` + HttpOnly. SGV can issue fully-authenticated keep-alive requests to
  Zendesk/Shopify-admin-class hosts riding the user's own session, zero credential handling. (The ride model's
  core assumption, now confirmed.)
- **`chrome.alarms` (30s min since Chrome 120) is the sanctioned scheduler.** SW dies after 30s idle (+5-min
  single-request cap), so the correct shape is alarm-fired short bursts — wake, ping/refresh, persist, die —
  never an in-memory loop. (This IS SGV's tick architecture; research says it's correct.)
- **Extension-page iframes are exempt from third-party-cookie blocking** (and since Chrome 115 storage
  partitioning, an iframed host the extension has permission for regains top-level unpartitioned storage) —
  which RESTORES hidden-iframe silent SSO (OIDC `prompt=none`) for the IdP-backed class, where a plain web
  page's silent re-auth breaks under ITP/ETP. A real rung-2 option worth adding to the spec.

## The self-destruct trap (for any future token-refresh rung)

For OIDC/SSO the refresh token IS the keep-alive — each exchange slides its own idle window (Auth0 30d, Okta
7d-unused even under "Unlimited"). **But rotation makes it a state-management problem with an UNRECOVERABLE
failure mode:** each exchange consumes the token + returns a replacement; fail to durably persist the newest,
or replay a stale one, and reuse-detection **revokes the whole token family** — strictly worse than doing
nothing. If SGV ever touches refresh tokens: atomic persist-the-newest is mandatory, and a botched retry is
DESTRUCTIVE, not a no-op.

## Honest gaps (could NOT confirm — do not spec as settled)

1. **Zendesk / Shopify actual session classes** — idle vs. absolute lifetimes, which endpoints count as
   activity, whether a params-free canary GET resets their idle timer at all. (Extension mechanics prove
   cookies attach; they do NOT prove a ping refreshes these two.)
2. **Anti-bot / WAF interaction** — whether Cloudflare `cf_clearance`, CSRF rotation, or fingerprinting FLAG or
   INVALIDATE a session when activity arrives from extension-context fetches rather than a rendered page. This
   is the real risk to the canary approach: a keep-alive ping that trips bot detection could CAUSE the logout.
3. How commercial RPA / password-manager / uptime tools keep sessions fresh (no established pattern surfaced).

## Net for SGV

Directionally correct, mechanics legitimate: (rung 1) alarm-driven low-frequency authenticated canaries on
ridden sessions; (rung 2) silent iframe re-auth for IdP-backed sites via the extension-page exemption — a real
addition to consider; (rung 4) honest detect→summon when absolute-lifetime / revocation / rotation-failure
forces real re-login. **Do NOT claim** until probed live: that a canary refreshes Zendesk/Shopify specifically,
or that canaries survive bot detection.

## Primary sources
OWASP Session Management Cheat Sheet + WSTG §4.6.7; Auth0 refresh-token & silent-auth docs; Okta refresh-token
guide; Duende IdentityServer refresh-token docs; Chrome extension storage-and-cookies + service-worker-lifecycle
+ chrome.alarms docs. Full claim/vote/source table: the wf_0ca89186 run journal.
