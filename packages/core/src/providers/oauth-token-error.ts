import { Data, Effect } from 'effect';

const SPENT_REFRESH_CODES: readonly string[] = [
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused',
];

/** Token endpoint rejection carrying its OAuth error code, so a terminal
 *  refusal is distinguishable from a transient failure. */
export class OAuthTokenError extends Data.TaggedError('OAuthTokenError')<{ readonly message: string }> {
  constructor(readonly issuer: 'cloudflare' | 'codex' | 'claude' | 'chatgpt', readonly oauthError: string, message: string) {
    super({ message });
  }

  get revoked(): boolean {
    return SPENT_REFRESH_CODES.includes(this.oauthError);
  }
}

export function unlessRevoked<A>(read: () => Promise<A>): Effect.Effect<A | 'revoked'> {
  return Effect.tryPromise({ try: read, catch: (cause) => ({ cause }) }).pipe(Effect.catch((failed) => (
    failed.cause instanceof OAuthTokenError && failed.cause.revoked ? Effect.succeed('revoked' as const) : Effect.die(failed.cause))));
}
