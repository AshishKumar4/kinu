const SPENT_REFRESH_CODES: readonly string[] = [
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused',
];

/** Token endpoint rejection carrying its OAuth error code, so a terminal
 *  refusal is distinguishable from a transient failure. */
export class OAuthTokenError extends Error {
  override readonly name = 'OAuthTokenError';

  constructor(readonly issuer: 'cloudflare' | 'codex' | 'claude' | 'chatgpt', readonly oauthError: string, message: string) {
    super(message);
  }

  get revoked(): boolean {
    return SPENT_REFRESH_CODES.includes(this.oauthError);
  }
}
