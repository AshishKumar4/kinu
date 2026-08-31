/**
 * Who is allowed to reach the admin control plane.
 * THREE SEPARATE QUESTIONS, and conflating them is the mistake this file exists
 * to make impossible.
 *
 * 0. DID CLOUDFLARE ACCESS ADMIT THIS REQUEST? Answered by `./access-gate`,
 *    OUTSIDE and BEFORE anything here — a verified `Cf-Access-Jwt-Assertion`
 *    against the team's JWKS, with the issuer and the application AUD pinned. It
 *    is a separate module because it is a separate authority: Cloudflare's, not
 *    ours, and this Worker's code cannot be talked out of it.
 *
 * 1. IS THIS HUMAN AN OPERATOR? Answered here, once, at the HTTP boundary, by
 *    `authorizeAdmin` — a verified browser-session email that appears in
 *    `CONTROL_PLANE_ADMINS`, that EQUALS the email Access authenticated, plus a
 *    fresh interactive sign-in for anything that mutates. Nothing below the
 *    boundary re-asks it, because nothing below the boundary can: a Durable
 *    Object sees a token, not a person.
 *
 * 2. IS THIS CALL FROM WORKER CODE THIS DEPLOYMENT TRUSTS? Answered by
 *    `capability.ts`, which is deliberately a separate module: the Durable Object
 *    needs that half and must not import this one.
 *
 * THE EMAIL EQUALITY IN QUESTION 1 IS WHAT JOINS GATE 0 TO GATE 1. Two gates
 * that each admit a different person are one gate: an attacker on the Access
 * policy who also holds a borrowed session cookie would otherwise pass both
 * halves while being neither party. Access says who is at the keyboard; the
 * session says whose account is acting; the plane runs only when they are the
 * same address.
 */
import { diagnostics } from '@kinu.run/core/obs';
import { hmacSha256Hex } from '../lib/crypto';
import { isFreshAuthTime, type AuthIdentity } from '../auth/session';
import type { AccessDenial, AccessIdentity } from './access-gate';
import {
  adminControlToken, ControlPlaneUnconfiguredError, type ControlCaller, type ControlSecretEnv,
} from './capability';

/** The Worker-side door to the gate's module. Exactly what a Worker route needs
 *  and nothing more: the DO takes its half from `./capability` directly, and a
 *  name re-exported here that nobody imports through here is a second door to
 *  the same room. */
export { internalCaller, type ControlCaller } from './capability';

/**
 * The operator caller.
 *
 * Takes the authorization the HTTP boundary produced rather than an identity, so
 * this token cannot be minted from a request that has not been through
 * `authorizeAdmin` — which in turn cannot be reached without a verified Access
 * identity to bind to. That is the whole reason the parameter is neither
 * optional nor an `AuthIdentity`: the ONE path to a Durable Object capability
 * runs through both gates, and the type system is what holds that rather than a
 * convention every future route has to remember.
 */
export async function adminCaller(
  env: ControlSecretEnv,
  _authorized: AuthorizedAdmin,
): Promise<ControlCaller> {
  return adminControlToken(env);
}

/* ── The HTTP boundary ───────────────────────────────────────────────────── */

/** Proof that a request carried an operator identity AND the Access identity it
 *  was matched against. Only `authorizeAdmin` produces one, and `adminCaller` is
 *  the only consumer, which is what stops an admin token being minted anywhere
 *  else. */
export interface AuthorizedAdmin {
  readonly email: string;
  readonly userId: string;
  /** Present when the request also cleared the step-up window, i.e. it may
   *  mutate. A read-only authorization leaves this false. */
  readonly fresh: boolean;
  /** The Cloudflare Access identity this authorization was bound to. Held rather
   *  than discarded so the structure itself says both gates were passed: an
   *  `AuthorizedAdmin` cannot be constructed without an `AccessIdentity`, and an
   *  `AccessIdentity` cannot be constructed without a verified assertion. */
  readonly access: AccessIdentity;
}

/**
 * Why a request is not an operator request.
 *
 * `not_admin`, `no_admins_configured` and `access_mismatch` all answer 404 rather
 * than 403: the existence of an admin surface is not something an ordinary user
 * needs to learn, and a 403 confirms the path. `stale_auth` DOES answer 403,
 * because the caller is a known operator whose two identities already agree and
 * the remedy is to sign in again — telling them that is the point.
 *
 * The `access_*` arms come from `./access-gate` and are refused at the outer gate
 * before any of this module runs, but they share this vocabulary because they
 * share the telemetry slot and the status table: one closed set of denial words
 * for the whole plane means a probe against `/control` and a probe against
 * `/api/control` are counted by the same query.
 */
export type AdminDenial =
  | AccessDenial
  | 'access_mismatch'
  | 'unconfigured'
  | 'no_admins_configured'
  | 'not_admin'
  | 'dev_identity'
  | 'token_identity'
  | 'stale_auth';

export type AdminAuthorization =
  | { readonly ok: true; readonly admin: AuthorizedAdmin }
  | { readonly ok: false; readonly denial: AdminDenial };

export interface AdminGateEnv extends ControlSecretEnv {
  CONTROL_PLANE_ADMINS?: string;
}

/** The allowlist, normalized. Emails are compared case-insensitively because
 *  that is how every provider in `auth/providers.ts` treats them, and a
 *  case-sensitive allowlist would silently exclude the operator who typed their
 *  own address with a capital. */
function controlPlaneAdmins(env: AdminGateEnv): readonly string[] {
  return (env.CONTROL_PLANE_ADMINS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** The app-side operator decision: identity shape and the allowlist, with no
 *  step-up and no Access binding. Its own function because the nav flag needs
 *  EXACTLY this and must not need an Access assertion — an ordinary
 *  `/api/user/profile` request carries none, since Access covers only the two
 *  control-plane paths and deliberately not the rest of the app. */
type OperatorLookup =
  | { readonly ok: true; readonly email: string }
  | {
      readonly ok: false;
      readonly denial: 'unconfigured' | 'no_admins_configured' | 'not_admin'
        | 'dev_identity' | 'token_identity';
    };

/**
 * Whether this session's email is an operator address on this deployment.
 *
 * THREE identity shapes are refused before the allowlist is even consulted, and
 * each one is a real reachable path in this deployment rather than a
 * hypothetical:
 *
 *   - `provider: 'dev'`. `DEV_USER_EMAIL` synthesizes an identity with
 *     `authTime: Date.now()` for EVERY request, and `env.staging` sets it. An
 *     allowlist match there would hand full operator authority, permanently
 *     fresh, to any unauthenticated caller who can reach the staging origin.
 *   - a scoped CLI access token (`cliScopes` present). That is a
 *     non-interactive long-lived credential; step-up over it means nothing, and
 *     the admin plane is not in any CLI scope.
 *   - an empty allowlist. Unset means nobody, never everybody.
 */
function operatorEmail(env: AdminGateEnv, identity: AuthIdentity): OperatorLookup {
  if (!(env.CREDENTIAL_ENCRYPTION_KEY ?? '').trim()) {
    return { ok: false, denial: 'unconfigured' };
  }
  if (identity.provider === 'dev') return { ok: false, denial: 'dev_identity' };
  if (identity.cliScopes !== undefined) return { ok: false, denial: 'token_identity' };

  const admins = controlPlaneAdmins(env);
  if (admins.length === 0) return { ok: false, denial: 'no_admins_configured' };

  const email = identity.email.trim().toLowerCase();
  if (email.length === 0 || !admins.includes(email)) return { ok: false, denial: 'not_admin' };
  return { ok: true, email };
}

/**
 * Whether the control-plane nav entry should be offered to this session.
 *
 * NOT AUTHORIZATION, and the difference is the point of the separate name. It
 * answers only the app-side half — is this email an operator address — because
 * that is the only half a request to `/api/user/profile` can be asked: Access
 * covers `/control*` and `/api/control*` and nothing else, so an ordinary
 * profile read carries no assertion to verify. The gate answers for itself on
 * every control-plane request; this only decides whether a link is drawn, and it
 * reads the allowlist through the SAME function `authorizeAdmin` does so the link
 * and the gate cannot disagree about who is on the list.
 */
export function isControlPlaneOperator(env: AdminGateEnv, identity: AuthIdentity): boolean {
  return operatorEmail(env, identity).ok;
}

/**
 * Decide whether a request may act as an operator.
 *
 * `access` is REQUIRED and is not an optimization: it is the proof the outer
 * Cloudflare Access gate ran, and taking it by value here is what makes an
 * un-gated admin route impossible to write. There is no arm that tolerates its
 * absence, because a tolerated absence is the whole defect this exists to close.
 *
 * THE EMAIL EQUALITY. Access authenticated one address and the browser session
 * carries another; both are verified, and if they differ the request is two
 * halves of two different people. That is refused as `access_mismatch` BEFORE the
 * step-up window is consulted, so a mismatched pair can never be answered with
 * the 403 "sign in again" that belongs to a recognized operator.
 *
 * `mutating` is not a convenience: a read and a write are different
 * authorizations, and the step-up window is the only thing standing between a
 * borrowed unlocked laptop and a destructive control-plane action.
 */
export function authorizeAdmin(
  env: AdminGateEnv,
  identity: AuthIdentity,
  access: AccessIdentity,
  options: { readonly mutating: boolean; readonly now?: number },
): AdminAuthorization {
  const operator = operatorEmail(env, identity);
  if (!operator.ok) return { ok: false, denial: operator.denial };
  if (operator.email !== access.email) return { ok: false, denial: 'access_mismatch' };

  const fresh = isFreshAuthTime(identity.authTime, options.now ?? Date.now());
  if (options.mutating && !fresh) return { ok: false, denial: 'stale_auth' };

  return { ok: true, admin: { email: operator.email, userId: identity.userId, fresh, access } };
}

/**
 * HTTP status for a denial.
 *
 * See `AdminDenial` for why the admin-existence denials are 404 and the
 * operator-recognized one is 403.
 *
 * EVERY `access_*` ARM IS 404, INCLUDING `access_unconfigured`. A 503 there
 * would be the one honest-looking answer that gives the game away: it says "this
 * path exists and something behind it is misconfigured", to a caller who by
 * definition did not pass Access. A deployment whose Access configuration is
 * missing is a deployment with no admin surface, and it answers exactly like one.
 * The operator learns about it from `scripts/infra-verify.ts`, which blocks the
 * deploy, and from the `access_unconfigured` rows in the operations dataset —
 * both places a stranger cannot see.
 *
 * The exhaustive switch is load-bearing: a new denial word added to the
 * vocabulary without a status here is a compile error rather than an
 * accidentally-200 admin response.
 */
export function adminDenialStatus(denial: AdminDenial): number {
  switch (denial) {
    case 'unconfigured': return 503;
    case 'stale_auth': return 403;
    case 'access_unconfigured':
    case 'access_missing':
    case 'access_invalid':
    case 'access_no_email':
    case 'access_mismatch':
    case 'no_admins_configured':
    case 'not_admin':
    case 'dev_identity':
    case 'token_identity':
      return 404;
  }
}

/** What the caller is told. The 404 arms all say the same thing as any other
 *  missing route, so a probe learns nothing from the wording either. */
export function adminDenialMessage(denial: AdminDenial): string {
  switch (denial) {
    case 'unconfigured':
      return 'The control plane is not configured on this deployment.';
    case 'stale_auth':
      return 'This action needs a fresh sign-in. Sign in again, then retry within five minutes.';
    default:
      return 'Not found';
  }
}

/**
 * A stable, non-reversible stand-in for an operator's email, for the analytics
 * marker and nothing else.
 *
 * The audit ROW keeps the real address — an audit trail that cannot name who
 * acted is not an audit trail. Analytics is the opposite case: it is queried by
 * anyone holding an account-analytics token, it is retained on the platform's
 * clock rather than ours, and an aggregate needs only to tell two operators
 * apart. So the address goes in the row and the digest goes in the dataset.
 */
export function actorDigest(env: ControlSecretEnv, email: string): Promise<string> {
  const secret = (env.CREDENTIAL_ENCRYPTION_KEY ?? '').trim();
  if (!secret) throw new ControlPlaneUnconfiguredError();
  return hmacSha256Hex(secret, `kinu.control-plane.actor.v1\u0000${email.trim().toLowerCase()}`)
    .then((hex) => hex.slice(0, 32));
}

/**
 * Report an admin-plane denial.
 *
 * Denials are the one thing an operator surface must never drop silently: a
 * probe against `/control` or `/api/control/*` is exactly the signal that
 * matters, and the scout audit of this backend recorded auth-denial telemetry as
 * absent.
 *
 * IT IS THE ONLY PLACE AN `access_*` DENIAL IS VISIBLE. Every Access arm answers
 * an indistinguishable 404 on the wire on purpose, so the row written here is the
 * whole difference between "somebody probed the admin path" (`access_missing` in
 * ones and twos), "requests are reaching this origin around Access"
 * (`access_missing` in volume, from real operator addresses), "this deployment
 * never configured Access" (`access_unconfigured`), and "a token we reject"
 * (`access_invalid`). Without it those four are one silent 404.
 *
 * `reason` and `outcome` are the two ALLOWLISTED slots on the operations
 * dataset, and they are what the emit has to fill. Reporting the denial under
 * its own field name left every row reading `outcome: 'ok'` with an empty
 * reason — a denial counted as a success, and the probe-versus-stale-sign-in
 * discriminator gone. `AdminDenial` is already a closed vocabulary, which is
 * exactly what the reason slot takes.
 *
 * `path` and `method` are reported for Workers Logs and are not allowlisted: a
 * path here can name a workspace, and a workspace name is mission-derived user
 * text. The email is never reported at all, because a rejected address is an
 * unverified string from a request.
 */
export function reportAdminDenial(denial: AdminDenial, path: string, method: string): void {
  diagnostics.event('control_plane.denied', { reason: denial, outcome: 'denied', path, method });
}
