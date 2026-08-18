// Codex OAuth device-code flow shared by web UserDO and local CLI.
//
// This mirrors the Codex CLI flow:
//   1. POST auth.openai.com/api/accounts/deviceauth/usercode
//   2. User enters the code at auth.openai.com/codex/device
//   3. Poll auth.openai.com/api/accounts/deviceauth/token
//   4. Exchange the authorization code at auth.openai.com/oauth/token
//
// Provider calls use the Codex CLI-style header bundle. Refresh ownership stays
// with the credential store that calls createCodexOAuthClient().
import * as v from 'valibot';
import type { OAuthCredential } from '../credentials/store';
import { isJsonObject, parseJsonObject, type JsonObject } from '../utils/json';
import { tolerate } from '../obs/index';

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_ISSUER = 'https://auth.openai.com';
export const CODEX_DEVICE_PORTAL = `${CODEX_ISSUER}/codex/device`;
export const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
export const CODEX_USER_AGENT = 'codex_cli_rs/0.0.0 (Proteus Agent)';
export const CODEX_ORIGINATOR = 'codex_cli_rs';

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

function sanitizeErrorBody(body: string): string {
  return body
    .replace(/("(access|refresh|id|code|user)_token"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$3')
    .replace(/("authorization_code"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/("code_verifier"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .slice(0, 512);
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

export interface CodexOAuthClient {
  startDeviceFlow(): Promise<DeviceCodeStart>;
  pollDeviceFlow(deviceAuthId: string, userCode: string): Promise<DeviceCodeTokens | null>;
  refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresAt?: number }>;
}

export function createCodexOAuthClient(fetchFn: typeof fetch = fetch): CodexOAuthClient {
  return {
    async startDeviceFlow(): Promise<DeviceCodeStart> {
      const res = await fetchFn(DEVICE_CODE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
      });
      if (!res.ok) {
        throw new Error(`Codex device-code request failed: ${res.status} ${sanitizeErrorBody(await res.text())}`);
      }
      const body = v.safeParse(DeviceCodeStartResponseSchema, await res.json());
      if (!body.success) {
        throw new Error('Codex device-code response missing required fields');
      }
      return {
        userCode: body.output.user_code,
        deviceAuthId: body.output.device_auth_id,
        pollIntervalSec: Math.max(3, Number(body.output.interval ?? 5)),
        portalURL: CODEX_DEVICE_PORTAL,
      };
    },

    async pollDeviceFlow(deviceAuthId, userCode): Promise<DeviceCodeTokens | null> {
      const pollRes = await fetchFn(DEVICE_POLL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      });
      if (pollRes.status === 403 || pollRes.status === 404) return null;
      if (!pollRes.ok) {
        throw new Error(`Codex poll failed: ${pollRes.status} ${sanitizeErrorBody(await pollRes.text())}`);
      }
      const poll = v.safeParse(DevicePollResponseSchema, await pollRes.json());
      if (!poll.success) {
        throw new Error('Codex poll response missing authorization_code/code_verifier');
      }
      const exchange = await fetchFn(CODEX_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: poll.output.authorization_code,
          redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`,
          client_id: CODEX_CLIENT_ID,
          code_verifier: poll.output.code_verifier,
        }).toString(),
      });
      if (!exchange.ok) {
        throw new Error(`Codex token exchange failed: ${exchange.status} ${sanitizeErrorBody(await exchange.text())}`);
      }
      const tokens = v.safeParse(TokenExchangeResponseSchema, await exchange.json());
      if (!tokens.success) {
        throw new Error('Codex token exchange missing access_token/refresh_token');
      }
      return {
        accessToken: tokens.output.access_token,
        refreshToken: tokens.output.refresh_token,
        idToken: tokens.output.id_token,
        expiresAt: tokens.output.expires_in ? Date.now() + tokens.output.expires_in * 1000 : undefined,
      };
    },

    async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresAt?: number }> {
      const res = await fetchFn(CODEX_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: CODEX_CLIENT_ID,
        }).toString(),
      });
      if (!res.ok) {
        throw new Error(`Codex token refresh failed: ${res.status} ${sanitizeErrorBody(await res.text())}`);
      }
      const body = v.safeParse(TokenExchangeResponseSchema, await res.json());
      if (!body.success) {
        throw new Error('Codex refresh response missing access_token/refresh_token');
      }
      return {
        accessToken: body.output.access_token,
        refreshToken: body.output.refresh_token,
        expiresAt: body.output.expires_in ? Date.now() + body.output.expires_in * 1000 : undefined,
      };
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

/** A JWT payload segment is unpadded base64url; a length of 4n+1 has no valid
 *  base64 form at all. `atob` throws for either, so both are refused here
 *  rather than caught — the decode below then cannot fail on the encoding. */
const JWT_PAYLOAD_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Decode a JWT's payload segment (base64url) — null when the token carries no
 *  decodable payload segment. A segment that decodes to something other than a
 *  JSON object propagates: that is a corrupt credential, not an absent claim,
 *  and every request built from it would otherwise fail as an opaque 401. */
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

export function codexAccessTokenExpiring(accessToken: string, skewSec = 60): boolean {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return true;
  const parsedExp = v.safeParse(v.number(), payload.exp);
  const exp = parsedExp.success ? parsedExp.output : null;
  if (exp == null) return false;
  return Date.now() / 1000 + skewSec >= exp;
}
