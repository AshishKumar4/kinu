/**
 * Admin control-plane authorization. Cloudflare Access (`./access-gate`) runs
 * first; `authorizeAdmin` then requires an allowlisted session email EQUAL to the
 * Access email, so one person must pass both gates. Worker-code trust is `capability.ts`.
 */
import { hmacSha256Hex } from '@kinu.run/core';
import { diagnostics } from '@kinu.run/core/obs';
import { isFreshAuthTime, type AuthIdentity } from '../auth/session';
import type { AccessDenial, AccessIdentity } from './access-gate';
import {
  adminControlToken, ControlPlaneUnconfiguredError, type ControlCaller, type ControlSecretEnv,
} from '@kinu.run/core/control-plane';

export { internalCaller, type ControlCaller } from '@kinu.run/core/control-plane';

/** Takes `AuthorizedAdmin`, not an identity, so the type system forces every
 *  admin token through both gates. */
export async function adminCaller(
  env: ControlSecretEnv,
  _authorized: AuthorizedAdmin,
): Promise<ControlCaller> {
  return adminControlToken(env);
}

/** Only `authorizeAdmin` produces one; only `adminCaller` consumes it. */
export interface AuthorizedAdmin {
  readonly email: string;
  readonly userId: string;
  /** Cleared the step-up window, i.e. may mutate. */
  readonly fresh: boolean;
  readonly access: AccessIdentity;
}

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

/** Case-insensitive, matching every provider in `auth/providers.ts`. */
function controlPlaneAdmins(env: AdminGateEnv): readonly string[] {
  return (env.CONTROL_PLANE_ADMINS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

type OperatorLookup =
  | { readonly ok: true; readonly email: string }
  | {
      readonly ok: false;
      readonly denial: 'unconfigured' | 'no_admins_configured' | 'not_admin'
        | 'dev_identity' | 'token_identity';
    };

/** App-side half only (no step-up, no Access). Dev identities are always fresh
 *  and CLI tokens non-interactive, so both are refused; empty allowlist = nobody. */
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

/** Nav-link visibility only, not authorization: profile requests carry no
 *  Access assertion. Shares `operatorEmail` with `authorizeAdmin`. */
export function isControlPlaneOperator(env: AdminGateEnv, identity: AuthIdentity): boolean {
  return operatorEmail(env, identity).ok;
}

/** `access` is required proof the Access gate ran. Email mismatch is checked
 *  before step-up so it never gets the operator-only 403. */
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

export interface AdminDenialAnswer {
  readonly status: number;
  readonly message: string;
}

/** 404 hides the admin surface (every `access_*` arm too, even unconfigured);
 *  403 only for a recognized operator needing step-up. Keep the switch exhaustive. */
export function adminDenialAnswer(denial: AdminDenial): AdminDenialAnswer {
  switch (denial) {
    case 'unconfigured':
      return { status: 503, message: 'The control plane is not configured on this deployment.' };
    case 'stale_auth':
      return { status: 403, message: 'This action needs a fresh sign-in. Sign in again, then retry within five minutes.' };
    case 'access_unconfigured':
    case 'access_missing':
    case 'access_invalid':
    case 'access_no_email':
    case 'access_mismatch':
    case 'no_admins_configured':
    case 'not_admin':
    case 'dev_identity':
    case 'token_identity':
      return { status: 404, message: 'Not found' };
  }
}

/** Non-reversible operator stand-in for analytics only; the audit row keeps the real email. */
export function actorDigest(env: ControlSecretEnv, email: string): Promise<string> {
  const secret = (env.CREDENTIAL_ENCRYPTION_KEY ?? '').trim();

  if (!secret) throw new ControlPlaneUnconfiguredError();

  return hmacSha256Hex(secret, `kinu.control-plane.actor.v1\u0000${email.trim().toLowerCase()}`)
    .then((hex) => hex.slice(0, 32));
}

/** The only place `access_*` denials are visible. `reason`/`outcome` are the
 *  dataset's allowlisted slots; `path` may name a workspace, so it stays out of them. */
export function reportAdminDenial(denial: AdminDenial, path: string, method: string): void {
  diagnostics.event('control_plane.denied', { reason: denial, outcome: 'denied', path, method });
}
