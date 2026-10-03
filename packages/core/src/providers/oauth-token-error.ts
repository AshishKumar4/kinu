import { Data } from 'effect';

const SPENT_REFRESH_CODES: readonly string[] = [
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused',
];

/** An OAuth code distinguishes a terminal refusal from a transient failure. */
export class OAuthTokenError extends Data.TaggedError('OAuthTokenError')<{ readonly message: string }> {
  constructor(readonly issuer: 'cloudflare' | 'codex' | 'claude' | 'chatgpt', readonly oauthError: string, message: string) {
    super({ message });
  }

  get revoked(): boolean {
    return SPENT_REFRESH_CODES.includes(this.oauthError);
  }
}

