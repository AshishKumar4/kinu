// Codex and Claude logins, any account: the CLI's config and a hosted account's credentials renew through this.
import { baseCredentialKey } from '../credentials/accounts';
import type { OAuthCredential } from '../credentials/store';
import { CLAUDE_CRED_KEY } from './claude';
import { CLAUDE_REFRESH_LEAD_MS, createClaudeOAuthClient } from './claude-oauth';
import { CODEX_CRED_KEY } from './codex';
import { CODEX_REFRESH_LEAD_SEC, codexAccessTokenExpiring, createCodexOAuthClient } from './codex-oauth';
import { OAuthTokenError } from './oauth-token-error';
import { diagnostics, KinuError, toKinuError } from '../obs/index';

export interface SubscriptionIssuer {
  /** Due for renewal: within its lead of expiring, or its token says so. */
  expiring(credential: OAuthCredential): boolean;
  refresh(credential: OAuthCredential, fetchFn?: typeof fetch): Promise<OAuthCredential>;
}

const CODEX_LOGIN_ISSUER: SubscriptionIssuer = {
  expiring: (credential) => (credential.expiresAt !== undefined && Date.now() + CODEX_REFRESH_LEAD_SEC * 1_000 >= credential.expiresAt)
    || codexAccessTokenExpiring(credential.accessToken),
  async refresh(credential, fetchFn) {
    const fresh = await createCodexOAuthClient(fetchFn).refresh(credential.refreshToken ?? '');

    return { kind: 'oauth', accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, expiresAt: fresh.expiresAt, metadata: credential.metadata };
  },
};

export const CLAUDE_LOGIN_ISSUER: SubscriptionIssuer = {
  expiring: (credential) => credential.expiresAt !== undefined && Date.now() + CLAUDE_REFRESH_LEAD_MS >= credential.expiresAt,
  refresh: (credential, fetchFn) => createClaudeOAuthClient(fetchFn).refresh(credential),
};

const ISSUERS: ReadonlyMap<string, SubscriptionIssuer> = new Map([[CODEX_CRED_KEY, CODEX_LOGIN_ISSUER], [CLAUDE_CRED_KEY, CLAUDE_LOGIN_ISSUER]]);

/** The issuer renewing a stored login, any account; null for other credentials. */
export function subscriptionIssuer(key: string): SubscriptionIssuer | null {
  return ISSUERS.get(baseCredentialKey(key)) ?? null;
}

/** One renewal's outcome under a store's fence: the login to use, `revoked` once it is retired, or why the issuer could not be asked. */
export type LoginRenewal = OAuthCredential | 'revoked' | { readonly failed: KinuError };

/** One rotation, its failure said once: a revoked refresh token for the store to retire, or an issuer it could not ask. */
export async function rotateLogin(key: string, doing: string, rotate: () => Promise<OAuthCredential>): Promise<LoginRenewal> {
  const [rotated] = await Promise.allSettled([rotate()]);

  if (rotated.status === 'fulfilled') return rotated.value;
  const cause: unknown = rotated.reason;

  if (cause instanceof OAuthTokenError && cause.revoked) {
    diagnostics.failure('credential.refresh_revoked', toKinuError({ doing, cause, otherwise: 'denied' }), { credentialKey: key });

    return 'revoked';
  }

  const failed = toKinuError({ doing, cause, otherwise: 'unavailable' });
  diagnostics.failure('credential.refresh_failed', failed, { credentialKey: key });

  return { failed };
}

/**
 * The one policy for a stored subscription login at a call, both backends. Without a refresh token it is no login. Due
 * or refused, it renews once through the store; a retired login answers null, and an unreachable issuer leaves the
 * held login, whose call may still succeed and whose 401 otherwise says to sign in again.
 */
export async function usableLogin(input: {
  readonly issuer: SubscriptionIssuer;
  readonly credential: OAuthCredential;
  readonly refused: boolean;
  readonly renew: () => Promise<LoginRenewal>;
}): Promise<OAuthCredential | null> {
  const { credential } = input;

  if (!credential.refreshToken) return null;

  if (!input.refused && !input.issuer.expiring(credential)) return credential;
  const renewed = await input.renew();

  if (renewed === 'revoked') return null;

  return 'failed' in renewed ? credential : renewed;
}
