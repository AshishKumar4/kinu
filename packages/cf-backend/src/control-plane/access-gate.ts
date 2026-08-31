/**
 * Cloudflare Access — the OUTER gate on the admin control plane.
 *
 * THREE GATES, IN THIS ORDER, and the ordering is the whole point of the file.
 *
 *   1. CLOUDFLARE ACCESS (here). Did Cloudflare's own identity layer let this
 *      request through, and can this Worker PROVE it rather than assume it? The
 *      proof is the RS256 assertion Access puts in `Cf-Access-Jwt-Assertion`,
 *      verified against the team's JWKS with the issuer and the application AUD
 *      pinned. Nothing in this deployment's own auth has run yet.
 *   2. THE APP SESSION AND OPERATOR ALLOWLIST (`admin-caller.ts`). Is this a
 *      signed-in Kinu session whose verified email is an operator, freshly?
 *   3. THE CAPABILITY (`capability.ts`). Is the call from Worker code holding a
 *      token derived from this deployment's root secret?
 *
 * WHY GATE 1 IS NOT REDUNDANT WITH GATE 2. Gate 2 trusts this deployment's own
 * session cookie, its own OAuth providers and its own allowlist var. Every one of
 * those is reachable by anyone who can reach the origin: a session-forgery bug, a
 * provider that hands back an email it did not verify, or an allowlist edited by
 * whoever can edit `wrangler.jsonc` is enough. Access is a gate this Worker's
 * code cannot be talked out of, held by Cloudflare, in front of the origin. So it
 * is an OUTER gate and not a replacement — `authorizeAdmin` still runs, still
 * consults `CONTROL_PLANE_ADMINS`, and still demands a fresh sign-in to mutate.
 *
 * WHY THE HEADER AND NEVER THE COOKIE. `CF_Authorization` is a cookie, so it is
 * ambient on every request the browser makes to the origin and a cross-site
 * request carries it. The assertion header is set by Access itself at the edge on
 * requests it has authorized, and reading it is the documented origin-side check
 * (Cloudflare One, "Application token"). A request that arrives with the cookie
 * and no header did not pass through Access.
 *
 * WHY VERIFICATION AND NEVER PRESENCE. A header is a string the client can send.
 * Cloudflare's own documentation is explicit that "validation of the header alone
 * is not sufficient — the JWT and signature must be confirmed to avoid identity
 * spoofing", and this Worker is reachable directly on its route rather than only
 * through a Tunnel, so there is no `cloudflared` doing it for us.
 *
 * WHAT IS PINNED, AND WHY EACH ONE:
 *   - `RS256`, alone. Access signs RS256. Leaving the algorithm open is how a
 *     verifier accepts `alg: none` or an HMAC over a key it published.
 *   - the ISSUER, exactly the configured team domain. A signature proves only
 *     that SOME Access organization signed it; without this, any Cloudflare
 *     customer's Access org is a valid signer for our admin plane.
 *   - the AUDIENCE, exactly the configured application AUD. Within one org, a
 *     token minted for a different application is a valid token; the AUD is what
 *     scopes it to THIS application.
 *   - `exp` and `nbf` REQUIRED, not merely checked-if-present. An absent claim
 *     that is only validated when present is an expiry check that the token
 *     itself gets to turn off.
 *   - `email` REQUIRED and non-empty. This refuses service tokens outright: they
 *     carry `sub: ""` and no email, step-up over them means nothing, and no
 *     machine is an operator of this plane.
 *
 * WHAT IT DOES NOT DO. It does not decide who is an operator — that is gate 2's
 * allowlist, and an Access policy is a different list maintained by different
 * people. Both must say yes.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import * as v from 'valibot';
import { diagnostics } from '@kinu.run/core/obs';

/** The header Cloudflare Access sets on requests it has authorized. Module-private
 *  on purpose: nothing outside this file has any business reading the raw
 *  assertion, and `unit-control-plane-access.test.ts` spells the wire name
 *  itself rather than importing it — a shared constant would let a rename pass
 *  both sides, while an independent literal pins the name Cloudflare fixed. */
const ACCESS_ASSERTION_HEADER = 'cf-access-jwt-assertion';

export interface ControlPlaneAccessEnv {
  /** `https://<team-name>.cloudflareaccess.com` — the Access organization whose
   *  signature and issuer this deployment accepts. */
  CONTROL_PLANE_ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's audience (AUD) tag. */
  CONTROL_PLANE_ACCESS_AUD?: string;
}

/**
 * Proof that Cloudflare Access authenticated this request, and who it says the
 * human is.
 *
 * Only `verifyControlPlaneAccess` produces one, and `authorizeAdmin` is the only
 * consumer — which is what makes "no operator authorization without a verified
 * Access identity" a property of the types rather than of a route's discipline.
 */
export interface AccessIdentity {
  /** The `email` claim, lowercased and trimmed. Verified by the identity
   *  provider Access is configured against, not by this deployment. */
  readonly email: string;
  /** The `sub` claim — Access's own user id, stable per email per account. Kept
   *  for the audit trail: it distinguishes a re-added user from the original. */
  readonly sub: string;
}

/**
 * Why Access did not admit a request.
 *
 * FOUR ARMS THAT ANSWER THE SAME 404, and they are four rather than one because
 * the wire answer and the operator's answer are different questions. On the wire
 * they must be indistinguishable: a deployment that says "Access is not
 * configured here" has told a stranger that there is an admin surface behind it.
 * In telemetry they must be distinct: `access_unconfigured` is an operator's
 * deployment mistake, `access_missing` means requests are reaching the origin
 * around Access, and `access_invalid` is either a forgery attempt or a rotated
 * team domain. Those are three different pages.
 */
export type AccessDenial =
  | 'access_unconfigured'
  | 'access_missing'
  | 'access_invalid'
  | 'access_no_email';

export type AccessVerification =
  | { readonly ok: true; readonly access: AccessIdentity }
  | { readonly ok: false; readonly denial: AccessDenial };

/* ── The protected surface ────────────────────────────────────────────────── */

/**
 * The admin UI's document paths: `/control` and anything below it.
 *
 * Two arms rather than `startsWith('/control')`, because that also matches
 * `/controlpanel` and every other path that merely begins with the word — and a
 * gate whose surface is wider than the Access application's coverage answers 404
 * to an operator forever, with no way to obtain the assertion it demands.
 *
 * Module-private: no caller needs the UI half alone. `server.ts` gates the whole
 * surface and `routes.ts` owns the API half, so an export here would be a second
 * door to a room with one occupant.
 */
function isControlPlaneUiPath(pathname: string): boolean {
  return pathname === '/control' || pathname.startsWith('/control/');
}

/** The admin API's paths. Same shape, same reason, and it must agree with the
 *  prefix test in `routes.ts` — which is why that module reads this one. */
export function isControlPlaneApiPath(pathname: string): boolean {
  return pathname === '/api/control' || pathname.startsWith('/api/control/');
}

/**
 * Every path this deployment requires an Access assertion for, and NOTHING else.
 *
 * THE NARROWNESS IS THE CONTRACT. Access covers exactly two path prefixes on the
 * app host — `/control*` and `/api/control*`. It deliberately does NOT cover the
 * root app, `/api/feedback`, `/api/client-errors`, the `*.kinu.run` preview
 * hostnames, or any workspace/sandbox origin. A host-wide Access application
 * would put an interactive login in front of every preview URL an agent hands
 * out and every unauthenticated landing page, which is not a hardening of this
 * product but a removal of it. `tests/unit-control-plane.test.ts` pins the
 * negative half of that set, and `scripts/infra-verify.ts` proves no Access
 * application on the account covers it either.
 */
export function isControlPlaneSurface(pathname: string): boolean {
  return isControlPlaneUiPath(pathname) || isControlPlaneApiPath(pathname);
}

/* ── Configuration ────────────────────────────────────────────────────────── */

/**
 * The configured team domain as an exact `https://host` origin, or `null`.
 *
 * NORMALIZED, THEN RE-DERIVED FROM THE PARSE. An operator pastes the value out of
 * the Zero Trust dashboard, so a missing scheme and a trailing slash are the two
 * realistic shapes, and both would otherwise produce an issuer string that never
 * equals the token's `iss` — a permanent 404 with a correct-looking config. What
 * is NOT tolerated is anything with a path, a query or credentials in it: the
 * value becomes both the JWKS URL's base and the pinned issuer, and a config that
 * is ambiguous about which origin it names is a config this cannot use.
 *
 * Module-private, and exercised through `verifyControlPlaneAccess`: every shape
 * below is either a config that verifies a real token or one that answers
 * `access_unconfigured`, and that is the property worth pinning rather than the
 * string this returns.
 */
function accessTeamOrigin(raw: string | undefined): string | null {
  const trimmed = (raw ?? '').trim().replace(/\/+$/u, '');
  if (trimmed.length === 0) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch (cause) {
    // `URL` throws exactly one thing for an unparseable input, and a value the
    // operator typed wrong is a configuration answer rather than a crash.
    if (!(cause instanceof TypeError)) throw cause;
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.origin;
}

/* ── The JWKS ─────────────────────────────────────────────────────────────── */

/**
 * The remote key set, one per team domain, held for the life of the isolate.
 *
 * MODULE SCOPE IS THE CACHE, and it has to be: `createRemoteJWKSet` does its own
 * fetching, coalescing, cooldown and key rotation, and all of that state lives in
 * the object. Constructing a new one per request throws every bit of it away and
 * turns each verification into an outbound fetch — a per-request HTTP dependency
 * in front of the admin plane, and a self-inflicted rate limit against
 * Cloudflare's own certs endpoint.
 *
 * KEYED BY TEAM DOMAIN rather than a single slot, so a deployment that changes
 * the var cannot be served by the previous organization's keys inside a warm
 * isolate. Bounded by construction: the key is config, and this Worker has one
 * value for it at a time.
 */
const keySets = new Map<string, JWTVerifyGetKey>();

function accessKeySet(teamOrigin: string): JWTVerifyGetKey {
  const cached = keySets.get(teamOrigin);
  if (cached !== undefined) return cached;
  const created = createRemoteJWKSet(new URL(`${teamOrigin}/cdn-cgi/access/certs`));
  keySets.set(teamOrigin, created);
  return created;
}

/* ── The gate ─────────────────────────────────────────────────────────────── */

/**
 * The two claims this gate acts on, parsed at the boundary rather than read out
 * of a dictionary. `email` refuses the empty string so a service token — whose
 * `sub` is empty and which carries no email — is refused rather than admitted
 * as an anonymous operator; both values arrive from a VERIFIED payload only.
 */
const AccessClaimsSchema = v.object({
  email: v.pipe(v.string(), v.transform((raw) => raw.trim().toLowerCase()), v.minLength(1)),
  sub: v.pipe(v.string(), v.minLength(1)),
});

/**
 * Verify the Cloudflare Access assertion on a request.
 *
 * FAILS CLOSED IN EVERY ARM. Unconfigured, absent, unparseable, wrongly signed,
 * wrong issuer, wrong audience, expired, not yet valid, or carrying no email —
 * all of them return a denial, none of them return an identity, and there is no
 * bypass flag and no development shortcut. A deployment that has not configured
 * Access has no reachable admin plane, which is the correct state for a
 * deployment that has not decided who its operators are.
 *
 * `jwtVerify` is the only thing that touches the token. Nothing here decodes a
 * segment, reads a claim before verification, or trusts the header's `kid` for
 * anything other than what the key set does with it.
 */
export async function verifyControlPlaneAccess(
  request: Request,
  env: ControlPlaneAccessEnv,
): Promise<AccessVerification> {
  const teamOrigin = accessTeamOrigin(env.CONTROL_PLANE_ACCESS_TEAM_DOMAIN);
  const audience = (env.CONTROL_PLANE_ACCESS_AUD ?? '').trim();
  if (teamOrigin === null || audience.length === 0) {
    return { ok: false, denial: 'access_unconfigured' };
  }

  const token = request.headers.get(ACCESS_ASSERTION_HEADER)?.trim() ?? '';
  if (token.length === 0) return { ok: false, denial: 'access_missing' };

  let claims: v.InferOutput<typeof AccessClaimsSchema>;
  try {
    const verified = await jwtVerify(token, accessKeySet(teamOrigin), {
      algorithms: ['RS256'],
      issuer: teamOrigin,
      audience,
      // Required rather than validated-when-present: `exp` and `nbf` are the
      // window, and a token that omits one has turned that half of the window
      // off. Access sets both on every identity token.
      requiredClaims: ['exp', 'nbf', 'email'],
      clockTolerance: 0,
    });
    const parsed = v.safeParse(AccessClaimsSchema, verified.payload);
    if (!parsed.success) return { ok: false, denial: 'access_no_email' };
    claims = parsed.output;
  } catch (caught) {
    // EVERY failure is one denial on the wire and one word in telemetry. jose's
    // message can embed claim values from a token an untrusted caller supplied,
    // so only the rejection's CLASS is recorded — never its text, and nothing
    // reaches a response body or an analytics slot. The distinction that
    // matters operationally, "reaching the origin around Access" versus "a
    // token we reject", is carried by `access_missing` versus `access_invalid`.
    diagnostics.event('control_plane.access_assertion_rejected', {
      failure: caught instanceof Error ? caught.name : 'non_error_rejection',
    });
    return { ok: false, denial: 'access_invalid' };
  }

  return { ok: true, access: { email: claims.email, sub: claims.sub } };
}
