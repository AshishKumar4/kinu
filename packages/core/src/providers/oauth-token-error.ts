import { Data } from 'effect';
import { SPENT_REFRESH_CODES } from './chatgpt-protocol';

/** An OAuth code distinguishes a terminal refusal from a transient failure. */
export class OAuthTokenError extends Data.TaggedError('OAuthTokenError')<{ readonly message: string }> {
  constructor(readonly issuer: 'cloudflare' | 'codex' | 'claude' | 'chatgpt', readonly oauthError: string, message: string) {
    super({ message });
  }

  get revoked(): boolean {
    return SPENT_REFRESH_CODES.includes(this.oauthError);
  }
}

