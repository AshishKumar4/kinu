/** Token endpoint rejection carrying its OAuth error code, so a terminal
 *  `invalid_grant` is distinguishable from a transient failure. */
export class OAuthTokenError extends Error {
  override readonly name = 'OAuthTokenError';

  constructor(readonly issuer: 'cloudflare' | 'codex' | 'claude', readonly oauthError: string, message: string) {
    super(message);
  }

  get revoked(): boolean {
    return this.oauthError === 'invalid_grant';
  }
}
