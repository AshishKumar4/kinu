// Codex OAuth device-code flow (mirrors the official codex-rs CLI).
//
//   client_id:  app_EMoamEEZ73f0CkXaXp7hrann   (public Codex CLI client_id)
//   issuer:     https://auth.openai.com
//   user-portal: https://auth.openai.com/codex/device
//
// Flow:
//   1. POST {issuer}/api/accounts/deviceauth/usercode  {client_id}
//      → { user_code, device_auth_id, interval }
//   2. UI shows user_code + portal URL; user enters code at portal.
//   3. Poll POST {issuer}/api/accounts/deviceauth/token {device_auth_id, user_code}
//      until 200 → { authorization_code, code_verifier }
//   4. POST {issuer}/oauth/token (grant_type=authorization_code, …)
//      → { access_token, refresh_token, … }
//
// Refresh: POST {issuer}/oauth/token (grant_type=refresh_token, refresh_token, client_id)
import type { OAuthCredential } from '@proteus/core';

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_ISSUER = 'https://auth.openai.com';
export const CODEX_DEVICE_PORTAL = `${CODEX_ISSUER}/codex/device`;
export const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
const DEVICE_CODE_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_POLL_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/token`;

/** Strip token-shaped fields from an upstream error body before including
 *  it in an Error message. Defense-in-depth: the OAuth server shouldn't
 *  echo tokens, but if it ever does we don't want them in our logs. */
function sanitizeErrorBody(body: string): string {
  return body
    .replace(/("(access|refresh|id|code|user)_token"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$3')
    .replace(/("authorization_code"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/("code_verifier"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .slice(0, 512);
}

export interface DeviceCodeStart {
  /** Code the user types into the portal. */
  userCode: string;
  /** Internal handle we pass to the poll endpoint. */
  deviceAuthId: string;
  /** Recommended polling interval in seconds. */
  pollIntervalSec: number;
  /** Portal URL the user opens. */
  portalURL: string;
}

export interface DeviceCodeTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix-ms expiry derived from the JWT's `exp` claim if present. */
  expiresAt?: number;
  idToken?: string;
}

export interface CodexOAuthClient {
  startDeviceFlow(): Promise<DeviceCodeStart>;
  /** Poll once. Returns tokens when authorized, null while pending. */
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
        user_code?: string; device_auth_id?: string; interval?: string | number;
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
      // Step 3: poll for authorization_code.
      const pollRes = await fetchFn(DEVICE_POLL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      });
      if (pollRes.status === 403 || pollRes.status === 404) return null; // user hasn't completed yet
      if (!pollRes.ok) {
        throw new Error(`Codex poll failed: ${pollRes.status} ${sanitizeErrorBody(await pollRes.text())}`);
      }
      const poll = await pollRes.json() as { authorization_code?: string; code_verifier?: string };
      if (!poll.authorization_code || !poll.code_verifier) {
        throw new Error('Codex poll response missing authorization_code/code_verifier');
      }
      // Step 4: exchange.
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
        access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number;
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

/** Convert exchanged tokens into the OAuthCredential shape stored by Proteus. */
export function tokensToCredential(t: DeviceCodeTokens, metadata?: Record<string, unknown>): OAuthCredential {
  return {
    kind: 'oauth',
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    expiresAt: t.expiresAt,
    metadata,
  };
}
