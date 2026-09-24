/**
 * Cloudflare Access: the outer admin gate, before the app session/operator allowlist
 * (`admin-caller.ts`) and the capability (`capability.ts`); not redundant, since those trust
 * this deployment's own cookie, OAuth and allowlist var. Reads the `Cf-Access-Jwt-Assertion`
 * header (the cookie is ambient) and verifies it: presence alone is spoofable (Cloudflare docs).
 * Pins RS256 only, issuer = team domain, aud = application AUD, requires `exp`/`nbf`, and a
 * non-empty `email` (refuses service tokens).
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import * as v from 'valibot';
import { diagnostics } from '@kinu.run/core/obs';

/** Module-private; the unit test spells the wire name independently so a rename cannot pass both sides. */
const ACCESS_ASSERTION_HEADER = 'cf-access-jwt-assertion';

export interface ControlPlaneAccessEnv {
  /** `https://<team-name>.cloudflareaccess.com` — the Access organization whose
     *  signature and issuer this deployment accepts. */
  CONTROL_PLANE_ACCESS_TEAM_DOMAIN?: string;
  CONTROL_PLANE_ACCESS_AUD?: string;
}

/** Only `verifyControlPlaneAccess` produces one; `authorizeAdmin` is the only consumer. */
export interface AccessIdentity {
  /** Lowercased, trimmed; verified by Access's identity provider, not this deployment. */
  readonly email: string;
  /** Kept for audit: distinguishes a re-added user from the original. */
  readonly sub: string;
}

/** All arms answer the same 404 on the wire; they stay distinct only for telemetry. */
export type AccessDenial =
  | 'access_unconfigured'
  | 'access_missing'
  | 'access_invalid'
  | 'access_no_email';

export type AccessVerification =
  | { readonly ok: true; readonly access: AccessIdentity }
  | { readonly ok: false; readonly denial: AccessDenial };

/** Two arms, not `startsWith('/control')`, which would also match `/controlpanel` beyond Access coverage. */
function isControlPlaneUiPath(pathname: string): boolean {
  return pathname === '/control' || pathname.startsWith('/control/');
}

/** Must agree with the prefix test in `routes.ts`, which reads this. */
function isControlPlaneApiPath(pathname: string): boolean {
  return pathname === '/api/control' || pathname.startsWith('/api/control/');
}

/**
 * Exactly `/control*` and `/api/control*`, nothing else: host-wide Access would gate previews and
 * public pages. Pinned by `tests/unit-control-plane.test.ts` and `scripts/infra-verify.ts`.
 */
export function isControlPlaneSurface(pathname: string): boolean {
  return isControlPlaneUiPath(pathname) || isControlPlaneApiPath(pathname);
}

/**
 * Normalizes a missing scheme or trailing slash (else `iss` never matches); rejects any path,
 * query or credentials, since the value is both the JWKS base and the pinned issuer.
 */
function accessTeamOrigin(raw: string | undefined): string | null {
  const trimmed = (raw ?? '').trim().replace(/\/+$/u, '');

  if (trimmed.length === 0) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;

  try {
    url = new URL(candidate);
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause;

    return null;
  }

  if (url.protocol !== 'https:') return null;

  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;

  if (url.username !== '' || url.password !== '') return null;

  return url.origin;
}

/**
 * Module scope is the cache: `createRemoteJWKSet` holds fetching, cooldown and rotation state.
 * Keyed by team domain so a changed var is never served the previous org's keys.
 */
const keySets = new Map<string, JWTVerifyGetKey>();

function accessKeySet(teamOrigin: string): JWTVerifyGetKey {
  const cached = keySets.get(teamOrigin);

  if (cached !== undefined) return cached;
  const created = createRemoteJWKSet(new URL(`${teamOrigin}/cdn-cgi/access/certs`));
  keySets.set(teamOrigin, created);

  return created;
}

/** `email` refuses the empty string so a service token is not admitted; parse verified payloads only. */
const AccessClaimsSchema = v.object({
  email: v.pipe(v.string(), v.transform((raw) => raw.trim().toLowerCase()), v.minLength(1)),
  sub: v.pipe(v.string(), v.minLength(1)),
});

/** Fails closed in every arm, with no bypass. Only `jwtVerify` touches the token. */
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
      // Required, not validated-when-present: a token omitting one would turn off half the window.
      requiredClaims: ['exp', 'nbf', 'email'],
      clockTolerance: 0,
    });

    const parsed = v.safeParse(AccessClaimsSchema, verified.payload);

    if (!parsed.success) return { ok: false, denial: 'access_no_email' };
    claims = parsed.output;
  } catch (caught) {
    // jose messages can embed attacker-supplied claim values: record only the rejection class.
    diagnostics.event('control_plane.access_assertion_rejected', {
      failure: caught instanceof Error ? caught.name : 'non_error_rejection',
    });

    return { ok: false, denial: 'access_invalid' };
  }

  return { ok: true, access: { email: claims.email, sub: claims.sub } };
}
