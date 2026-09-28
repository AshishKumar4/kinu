// Codex OAuth device-code flow (mirrors the Codex CLI), shared by web UserDO and local CLI.
// Refresh ownership stays with the credential store that calls createCodexOAuthClient().
import * as v from 'valibot';
import { OAuthTokenError } from './oauth-token-error';
import { oauthRefusalText } from './oauth-refusal';
import type { OAuthCredential } from '../credentials/store';
import { isJsonObject, parseJsonObject, type JsonObject } from '../utils/json';
import { Effect } from 'effect';
import { settle, tolerate } from '../obs/index';

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const CODEX_ISSUER = 'https://auth.openai.com';

const CODEX_DEVICE_PORTAL = `${CODEX_ISSUER}/codex/device`;

export const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;

const CODEX_USER_AGENT = 'codex_cli_rs/0.0.0 (Kinu Agent)';

const CODEX_ORIGINATOR = 'codex_cli_rs';

const DEVICE_CODE_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`;

const DEVICE_POLL_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/token`;

const DeviceCodeStartResponseSchema = v.object({
  user_code: v.pipe(v.string(), v.minLength(1)),
  device_auth_id: v.pipe(v.string(), v.minLength(1)),
  interval: v.optional(v.union([v.string(), v.number()])),
});

const DevicePollResponseSchema = v.object({
  authorization_code: v.pipe(v.string(), v.minLength(1)),
  code_verifier: v.pipe(v.string(), v.minLength(1)),
});

const TokenExchangeResponseSchema = v.object({
  access_token: v.pipe(v.string(), v.minLength(1)),
  refresh_token: v.pipe(v.string(), v.minLength(1)),
  id_token: v.optional(v.string()),
  expires_in: v.optional(v.number()),
});

function oauthErrorCode(body: string): string | undefined {
  const rejection = v.safeParse(
    v.object({ error: v.optional(v.string()) }),
    tolerate<unknown>(() => JSON.parse(body), 'malformed-input'),
  );

  return rejection.success ? rejection.output.error : undefined;
}

/** A body without an `error` code yields `unknown`, never a terminal code. */
async function codexTokenEndpointError(res: Response): Promise<OAuthTokenError> {
  const code = oauthErrorCode(await res.text());

  return new OAuthTokenError('codex', code === undefined || code === '' ? 'unknown' : code,
    oauthRefusalText('Codex token refresh failed', { ...(code !== undefined && { code }), status: res.status }));
}


/** Read a rejected device-code poll: an explicit terminal code wins; else 403 is pending and 404 expired. */
function devicePollRejection(res: Response): Effect.Effect<DeviceCodePoll> {
  return Effect.flatMap(Effect.promise(() => res.text()), (body) => pollAnswer(res, body));
}

function pollAnswer(res: Response, body: string): Effect.Effect<DeviceCodePoll> {

  const code = oauthErrorCode(body);

  if (code === 'access_denied') return Effect.succeed({ status: 'denied', message: 'Codex login denied. Run kinu setup again.' });

  if (code === 'expired_token' || res.status === 404) {
    return Effect.succeed({ status: 'expired', message: 'Codex login expired. Run kinu setup again.' });
  }

  if (res.status === 403) return Effect.succeed({ status: 'pending' });

  return Effect.die(new Error(oauthRefusalText('Codex poll failed', { ...(code !== undefined && { code }), status: res.status })));
}

export interface DeviceCodeStart {
  userCode: string;
  deviceAuthId: string;
  pollIntervalSec: number;
  portalURL: string;
}

export interface DeviceCodeTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
  idToken?: string;
}

/** `pending` means ask again; anything else ends the wait. */
export type DeviceCodePoll =
  | { status: 'pending' }
  | { status: 'expired'; message: string }
  | { status: 'denied'; message: string }
  | { status: 'granted'; tokens: DeviceCodeTokens };

export interface CodexOAuthClient {
  startDeviceFlow(): Promise<DeviceCodeStart>;
  pollDeviceFlow(deviceAuthId: string, userCode: string): Promise<DeviceCodePoll>;
  refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresAt?: number }>;
}

export function createCodexOAuthClient(fetchFn: typeof fetch = fetch): CodexOAuthClient {
  return {
    async startDeviceFlow(): Promise<DeviceCodeStart> {
      return settle(Effect.gen(function* () {
        const res = yield* Effect.promise(() => fetchFn(DEVICE_CODE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
        }));

        if (!res.ok) {
          const code = oauthErrorCode(yield* Effect.promise(() => res.text()));

          return yield* Effect.die(new Error(oauthRefusalText('Codex device-code request failed', { ...(code !== undefined && { code }), status: res.status })));
        }

        const body = v.safeParse(DeviceCodeStartResponseSchema, yield* Effect.promise(() => res.json()));

        if (!body.success) {
          return yield* Effect.die(new Error('Codex device-code response missing required fields'));
        }

        return {
          userCode: body.output.user_code,
          deviceAuthId: body.output.device_auth_id,
          pollIntervalSec: Math.max(3, Number(body.output.interval ?? 5)),
          portalURL: CODEX_DEVICE_PORTAL,
        };
      }));
    },

    async pollDeviceFlow(deviceAuthId, userCode): Promise<DeviceCodePoll> {
      return settle(Effect.gen(function* () {
        const pollRes = yield* Effect.promise(() => fetchFn(DEVICE_POLL_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        }));

        if (!pollRes.ok) return yield* devicePollRejection(pollRes);
        const poll = v.safeParse(DevicePollResponseSchema, yield* Effect.promise(() => pollRes.json()));

        if (!poll.success) {
          return yield* Effect.die(new Error('Codex poll response missing authorization_code/code_verifier'));
        }

        const exchange = yield* Effect.promise(() => fetchFn(CODEX_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: poll.output.authorization_code,
            redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`,
            client_id: CODEX_CLIENT_ID,
            code_verifier: poll.output.code_verifier,
          }).toString(),
        }));

        if (!exchange.ok) {
          const code = oauthErrorCode(yield* Effect.promise(() => exchange.text()));

          return yield* Effect.die(new Error(oauthRefusalText('Codex token exchange failed', { ...(code !== undefined && { code }), status: exchange.status })));
        }

        const tokens = v.safeParse(TokenExchangeResponseSchema, yield* Effect.promise(() => exchange.json()));

        if (!tokens.success) {
          return yield* Effect.die(new Error('Codex token exchange missing access_token/refresh_token'));
        }

        return {
          status: 'granted',
          tokens: {
            accessToken: tokens.output.access_token,
            refreshToken: tokens.output.refresh_token,
            idToken: tokens.output.id_token,
            expiresAt: tokens.output.expires_in ? Date.now() + tokens.output.expires_in * 1000 : undefined,
          },
        };
      }));
    },

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

export function tokensToCredential(t: DeviceCodeTokens, metadata?: JsonObject): OAuthCredential {
  return {
    kind: 'oauth',
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    expiresAt: t.expiresAt,
    metadata,
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
