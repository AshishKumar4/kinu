// Codex OAuth device-code flow (mirrors the Codex CLI), shared by web UserDO and local CLI.
// Refresh ownership stays with the credential store that calls createCodexOAuthClient().
import * as v from 'valibot';
import { OAuthTokenError } from './oauth-token-error';
import type { OAuthCredential } from '../credentials/store';
import { isJsonObject, parseJsonObject, type JsonObject } from '../utils/json';
import { Effect } from 'effect';
import { settle, tolerate } from '../obs/index';

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const CODEX_ISSUER = 'https://auth.openai.com';

export const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;

const CODEX_USER_AGENT = 'codex_cli_rs/0.0.0 (Kinu Agent)';

const CODEX_ORIGINATOR = 'codex_cli_rs';

const TokenExchangeResponseSchema = v.object({
  access_token: v.pipe(v.string(), v.minLength(1)),
  refresh_token: v.pipe(v.string(), v.minLength(1)),
  id_token: v.optional(v.string()),
  expires_in: v.optional(v.number()),
});

function sanitizeErrorBody(body: string): string {
  return body
    .replace(/("(access|refresh|id|code|user)_token"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$3')
    .replace(/("authorization_code"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/("code_verifier"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .slice(0, 512);
}

/** A body without an `error` code yields `unknown`, never a terminal code. */
async function codexTokenEndpointError(res: Response): Promise<OAuthTokenError> {
  const body = await res.text();

  const rejection = v.safeParse(
    v.object({ error: v.optional(v.string()) }),
    tolerate<unknown>(() => JSON.parse(body), 'malformed-input'),
  );

  return new OAuthTokenError('codex',
    rejection.success && rejection.output.error ? rejection.output.error : 'unknown',
    `Codex token refresh failed: ${res.status} ${sanitizeErrorBody(body)}`,
  );
}

export interface CodexOAuthClient {
  refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresAt?: number }>;
}

export function createCodexOAuthClient(fetchFn: typeof fetch = fetch): CodexOAuthClient {
  return {
    async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresAt?: number }> {
      return settle(Effect.gen(function* () {
        const res = yield* Effect.promise(() => fetchFn(CODEX_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: CODEX_CLIENT_ID,
          }).toString(),
        }));

        if (!res.ok) {
          return yield* Effect.die(yield* Effect.promise(() => codexTokenEndpointError(res)));
        }

        const body = v.safeParse(TokenExchangeResponseSchema, yield* Effect.promise(() => res.json()));

        if (!body.success) {
          return yield* Effect.die(new Error('Codex refresh response missing access_token/refresh_token'));
        }

        return {
          accessToken: body.output.access_token,
          refreshToken: body.output.refresh_token,
          expiresAt: body.output.expires_in ? Date.now() + body.output.expires_in * 1000 : undefined,
        };
      }));
    },
  };
}

/** Unpadded base64url of length 4n+1 has no valid form; refused here so the decode below cannot throw. */
const JWT_PAYLOAD_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Decode a JWT payload segment; null when absent. A non-object payload throws as a corrupt credential. */
function decodeJwtPayload(token: string): JsonObject | null {
  const segment = token.split('.')[1];

  if (segment === undefined || segment.length % 4 === 1 || !JWT_PAYLOAD_SEGMENT.test(segment)) return null;
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);

  return tolerate(() => parseJsonObject(globalThis.atob(padded)), 'malformed-input') ?? null;
}

export function decodeCodexAccountId(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.['https://api.openai.com/auth'];

  if (auth === undefined || !isJsonObject(auth)) return null;
  const id = v.safeParse(v.pipe(v.string(), v.minLength(1)), auth.chatgpt_account_id);

  return id.success ? id.output : null;
}

export function codexCredentialToHeaders(cred: OAuthCredential) {
  const headers = {
    Authorization: `Bearer ${cred.accessToken}`,
    'User-Agent': CODEX_USER_AGENT,
    originator: CODEX_ORIGINATOR,
  };

  const metadataAccountId = cred.metadata?.accountId;

  const parsedMetadataAccountId = v.safeParse(
    v.pipe(v.string(), v.minLength(1)),
    metadataAccountId,
  );

  const accountId = decodeCodexAccountId(cred.accessToken)
    ?? (parsedMetadataAccountId.success ? parsedMetadataAccountId.output : null);

  if (!accountId) return headers;

  return { ...headers, 'ChatGPT-Account-ID': accountId };
}

/** How early a Codex access token counts as expiring. Not derived: Codex's actual `expires_in` is unrecorded. */
export const CODEX_REFRESH_LEAD_SEC = 300;

export function codexAccessTokenExpiring(accessToken: string, skewSec = CODEX_REFRESH_LEAD_SEC): boolean {
  const payload = decodeJwtPayload(accessToken);

  if (!payload) return true;
  const parsedExp = v.safeParse(v.number(), payload.exp);
  const exp = parsedExp.success ? parsedExp.output : null;

  if (exp == null) return false;

  return Date.now() / 1000 + skewSec >= exp;
}
