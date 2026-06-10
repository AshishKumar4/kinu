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
import type { OAuthCredential } from '../credentials/store.js';

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_ISSUER = 'https://auth.openai.com';
export const CODEX_DEVICE_PORTAL = `${CODEX_ISSUER}/codex/device`;
export const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
export const CODEX_USER_AGENT = 'codex_cli_rs/0.0.0 (Proteus Agent)';
export const CODEX_ORIGINATOR = 'codex_cli_rs';

const DEVICE_CODE_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_POLL_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/token`;

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
      const body = await res.json() as {
        user_code?: string;
        device_auth_id?: string;
        interval?: string | number;
      };
      if (!body.user_code || !body.device_auth_id) {
        throw new Error('Codex device-code response missing required fields');
      }
      return {
        userCode: body.user_code,
        deviceAuthId: body.device_auth_id,
        pollIntervalSec: Math.max(3, Number(body.interval ?? 5)),
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
      const poll = await pollRes.json() as { authorization_code?: string; code_verifier?: string };
      if (!poll.authorization_code || !poll.code_verifier) {
        throw new Error('Codex poll response missing authorization_code/code_verifier');
      }
      const exchange = await fetchFn(CODEX_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: poll.authorization_code,
          redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`,
          client_id: CODEX_CLIENT_ID,
          code_verifier: poll.code_verifier,
        }).toString(),
      });
      if (!exchange.ok) {
        throw new Error(`Codex token exchange failed: ${exchange.status} ${sanitizeErrorBody(await exchange.text())}`);
      }
      const tokens = await exchange.json() as {
        access_token?: string;
        refresh_token?: string;
        id_token?: string;
        expires_in?: number;
      };
      if (!tokens.access_token || !tokens.refresh_token) {
        throw new Error('Codex token exchange missing access_token/refresh_token');
      }
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
        expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
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
      const body = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!body.access_token || !body.refresh_token) {
        throw new Error('Codex refresh response missing access_token/refresh_token');
      }
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
      };
    },
  };
}

export function tokensToCredential(t: DeviceCodeTokens, metadata?: Record<string, unknown>): OAuthCredential {
  return {
    kind: 'oauth',
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    expiresAt: t.expiresAt,
    metadata,
  };
}

/** Decode a JWT's payload segment (base64url) — null when undecodable. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    const json: unknown = JSON.parse(typeof atob === 'function'
      ? atob(padded)
      : Buffer.from(padded, 'base64').toString('utf-8'));
    return json && typeof json === 'object' && !Array.isArray(json)
      ? json as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function decodeCodexAccountId(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.['https://api.openai.com/auth'];
  const id = auth && typeof auth === 'object'
    ? (auth as Record<string, unknown>).chatgpt_account_id
    : undefined;
  return typeof id === 'string' && id ? id : null;
}

export function codexCredentialToHeaders(cred: OAuthCredential): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cred.accessToken}`,
    'User-Agent': CODEX_USER_AGENT,
    originator: CODEX_ORIGINATOR,
  };
  const metadataAccountId = cred.metadata?.accountId;
  const accountId = decodeCodexAccountId(cred.accessToken)
    ?? (typeof metadataAccountId === 'string' && metadataAccountId ? metadataAccountId : null);
  if (accountId) headers['ChatGPT-Account-ID'] = accountId;
  return headers;
}

export function codexAccessTokenExpiring(accessToken: string, skewSec = 60): boolean {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return true;
  const exp = typeof payload.exp === 'number' ? payload.exp : null;
  if (exp == null) return false;
  return Date.now() / 1000 + skewSec >= exp;
}
