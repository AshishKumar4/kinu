/**
 * Who is allowed to reach the admin control plane.
 *
 * TWO SEPARATE QUESTIONS, and conflating them is the mistake this file exists to
 * make impossible.
 *
 * 1. IS THIS HUMAN AN OPERATOR? Answered here, once, at the HTTP boundary, by
 *    `authorizeAdmin` — a verified browser-session email that appears in
 *    `CONTROL_PLANE_ADMINS`, plus a fresh interactive sign-in for anything that
 *    mutates. Nothing below the boundary re-asks it, because nothing below the
 *    boundary can: a Durable Object sees a token, not a person.
 *
 * 2. IS THIS CALL FROM WORKER CODE THIS DEPLOYMENT TRUSTS? Answered by
 *    `capability.ts`, which is deliberately a separate module: the Durable Object
 *    needs that half and must not import this one.
 */
import { diagnostics } from '@kinu.run/core/obs';
import { hmacSha256Hex } from '../lib/crypto';
import { isFreshAuthTime, type AuthIdentity } from '../auth/session';
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
 * `authorizeAdmin`. That is the whole reason the parameter is neither optional
 * nor an `AuthIdentity`.
 */
export async function adminCaller(
  env: ControlSecretEnv,
  _authorized: AuthorizedAdmin,
): Promise<ControlCaller> {
  return adminControlToken(env);
}

/* ── The HTTP boundary ───────────────────────────────────────────────────── */

/** Proof that a request carried an operator identity. Only `authorizeAdmin`
 *  produces one, and `adminCaller` is the only consumer, which is what stops an
 *  admin token being minted anywhere else. */
export interface AuthorizedAdmin {
  readonly email: string;
  readonly userId: string;
  /** Present when the request also cleared the step-up window, i.e. it may
   *  mutate. A read-only authorization leaves this false. */
  readonly fresh: boolean;
}

/**
 * Why a request is not an operator request.
 *
 * `not_admin` and `no_admins_configured` both answer 404 rather than 403: the
 * existence of an admin surface is not something an ordinary user needs to
 * learn, and a 403 confirms the path. `stale_auth` DOES answer 403, because the
 * caller is a known operator and the remedy is to sign in again — telling them
 * that is the point.
 */
export type AdminDenial =
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

/**
 * Decide whether a request may act as an operator.
 *
 * `mutating` is not a convenience: a read and a write are different
 * authorizations, and the step-up window is the only thing standing between a
 * borrowed unlocked laptop and a destructive control-plane action.
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
export function authorizeAdmin(
  env: AdminGateEnv,
  identity: AuthIdentity,
  options: { readonly mutating: boolean; readonly now?: number },
): AdminAuthorization {
  if (!(env.CREDENTIAL_ENCRYPTION_KEY ?? '').trim()) {
    return { ok: false, denial: 'unconfigured' };
  }
  if (identity.provider === 'dev') return { ok: false, denial: 'dev_identity' };
  if (identity.cliScopes !== undefined) return { ok: false, denial: 'token_identity' };

  const admins = controlPlaneAdmins(env);
  if (admins.length === 0) return { ok: false, denial: 'no_admins_configured' };

  const email = identity.email.trim().toLowerCase();
  if (email.length === 0 || !admins.includes(email)) return { ok: false, denial: 'not_admin' };

  const fresh = isFreshAuthTime(identity.authTime, options.now ?? Date.now());
  if (options.mutating && !fresh) return { ok: false, denial: 'stale_auth' };

  return { ok: true, admin: { email, userId: identity.userId, fresh } };
}

/** HTTP status for a denial. See `AdminDenial` for why the admin-existence
 *  denials are 404 and the operator-recognized one is 403. */
export function adminDenialStatus(denial: AdminDenial): number {
  switch (denial) {
    case 'unconfigured': return 503;
    case 'stale_auth': return 403;
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
 * probe against `/api/control/*` is exactly the signal that matters, and the
 * scout audit of this backend recorded auth-denial telemetry as absent.
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
