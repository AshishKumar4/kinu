// Codex and Claude logins, any account: the CLI's config and a hosted account's credentials renew through this.
import { baseCredentialKey } from '../credentials/accounts';
import type { OAuthCredential } from '../credentials/store';
import { CLAUDE_CRED_KEY } from './claude';
import { CLAUDE_REFRESH_LEAD_MS, createClaudeOAuthClient } from './claude-oauth';
import { CODEX_CRED_KEY } from './codex';
import { CODEX_REFRESH_LEAD_SEC, codexAccessTokenExpiring, createCodexOAuthClient } from './codex-oauth';

export interface SubscriptionIssuer {
  /** Due for renewal: within its lead of expiring, or its token says so. */
  expiring(credential: OAuthCredential): boolean;
  refresh(credential: OAuthCredential, fetchFn?: typeof fetch): Promise<OAuthCredential>;
}

export const CODEX_LOGIN_ISSUER: SubscriptionIssuer = {
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
