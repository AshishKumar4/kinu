/** A token endpoint's rejection with its OAuth error code, so a caller can
 *  tell a terminal `invalid_grant` (a revoked or expired refresh token) from a
 *  transient failure. One class per distinction, whichever issuer answered. */
export class OAuthTokenError extends Error {
  override readonly name = 'OAuthTokenError';

  constructor(readonly issuer: 'cloudflare' | 'codex', readonly oauthError: string, message: string) {
    super(message);
  }

  get revoked(): boolean {
    return this.oauthError === 'invalid_grant';
  }
}
