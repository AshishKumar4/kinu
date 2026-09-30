// The ChatGPT plan's login on this machine, renewed by the module the device daemon runs too
// (packages/pc-agent/src/chatgpt.js): one Sign in with ChatGPT implementation for both processes.
import { OAuthTokenError, type OAuthCredential, type SubscriptionIssuer } from '@kinu.run/core';
import { settle } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import * as v from 'valibot';
import { expiring, refreshTokens, SiwcError } from '../../pc-agent/src/chatgpt.js';

const RegistrationSchema = v.object({ clientId: v.string(), scopes: v.optional(v.array(v.string()), []) });

/** Renews with the login's issued client; a spent refresh token rejects as a revoked `OAuthTokenError`. */
export function chatgptLoginIssuer(): SubscriptionIssuer {
  return {
    expiring: (credential) => expiring(credential, Date.now()),
    refresh(credential, fetchFn) {
      return settle(Effect.gen(function* () {
        const registration = v.safeParse(RegistrationSchema, credential.metadata);
        const refreshToken = credential.refreshToken;

        if (!registration.success || refreshToken === undefined) {
          return yield* Effect.die(new OAuthTokenError('chatgpt', 'invalid_grant', 'the stored ChatGPT login has no refresh token or client to renew with'));
        }

        const tokens = yield* Effect.promise(() => refreshTokens({
          clientId: registration.output.clientId,
          refreshToken,
          scopes: registration.output.scopes,
          ...(fetchFn !== undefined && { fetch: fetchFn }),
        })).pipe(Effect.catchDefect((defect) => Effect.die(defect instanceof SiwcError
          ? new OAuthTokenError('chatgpt', defect.code ?? 'unknown', defect.message)
          : defect)));

        if (tokens.accessToken === undefined) {
          return yield* Effect.die(new OAuthTokenError('chatgpt', 'unknown', 'auth.openai.com renewed the ChatGPT login without an access token'));
        }

        return {
          kind: 'oauth',
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? refreshToken,
          expiresAt: tokens.expiresAt,
          metadata: { ...credential.metadata, scopes: [...tokens.scopes], savedAt: tokens.savedAt },
        } satisfies OAuthCredential;
      }));
    },
  };
}
