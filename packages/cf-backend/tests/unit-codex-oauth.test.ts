import { describe, test, expect } from 'bun:test';
import {
  createCodexOAuthClient, CODEX_CLIENT_ID, CODEX_DEVICE_PORTAL,
  CODEX_TOKEN_URL, tokensToCredential,
} from '../src/auth/codex-oauth.ts';
import { createMockFetch } from '@proteus/test-utils';

describe('Codex OAuth device-code flow', () => {
  test('startDeviceFlow POSTs to /api/accounts/deviceauth/usercode with client_id', async () => {
    const mock = createMockFetch([
      {
        match: 'deviceauth/usercode',
        respond: {
          status: 200,
          body: { user_code: 'ABCD-1234', device_auth_id: 'dev-xyz', interval: '5' },
        },
      },
    ]);
    const client = createCodexOAuthClient(mock.fetch);
    const result = await client.startDeviceFlow();

    expect(result.userCode).toBe('ABCD-1234');
    expect(result.deviceAuthId).toBe('dev-xyz');
    expect(result.pollIntervalSec).toBe(5);
    expect(result.portalURL).toBe(CODEX_DEVICE_PORTAL);

    const req = mock.requests[0];
    expect(req.method).toBe('POST');
    expect(req.url).toContain('deviceauth/usercode');
    expect(JSON.parse(req.body!).client_id).toBe(CODEX_CLIENT_ID);
  });

  test('startDeviceFlow throws on non-200', async () => {
    const mock = createMockFetch([
      { match: 'deviceauth/usercode', respond: { status: 500, body: 'oops' } },
    ]);
    const client = createCodexOAuthClient(mock.fetch);
    await expect(client.startDeviceFlow()).rejects.toThrow(/device-code request failed/);
  });

  test('pollDeviceFlow returns null while user hasn\'t authorized (403/404)', async () => {
    const mock = createMockFetch([
      { match: 'deviceauth/token', respond: { status: 403, body: 'pending' } },
    ]);
    const client = createCodexOAuthClient(mock.fetch);
    expect(await client.pollDeviceFlow('dev', 'code')).toBeNull();
  });

  test('pollDeviceFlow exchanges authorization_code on 200', async () => {
    const mock = createMockFetch([
      {
        match: 'deviceauth/token',
        respond: {
          status: 200,
          body: { authorization_code: 'auth-abc', code_verifier: 'verifier-xyz' },
        },
      },
      {
        match: 'oauth/token',
        respond: {
          status: 200,
          body: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 },
        },
      },
    ]);
    const client = createCodexOAuthClient(mock.fetch);
    const tokens = await client.pollDeviceFlow('dev', 'code');
    expect(tokens?.accessToken).toBe('AT');
    expect(tokens?.refreshToken).toBe('RT');
    expect(tokens?.expiresAt).toBeGreaterThan(Date.now());

    // Step 4 exchange goes to /oauth/token with grant_type=authorization_code
    const exchange = mock.requests.find(r => r.url.includes('oauth/token'));
    expect(exchange).toBeDefined();
    expect(exchange!.body).toContain('grant_type=authorization_code');
    expect(exchange!.body).toContain('client_id=' + CODEX_CLIENT_ID);
    expect(exchange!.body).toContain('code=auth-abc');
    expect(exchange!.body).toContain('code_verifier=verifier-xyz');
  });

  test('refresh POSTs grant_type=refresh_token to oauth/token', async () => {
    const mock = createMockFetch([
      {
        match: 'oauth/token',
        respond: {
          status: 200,
          body: { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 },
        },
      },
    ]);
    const client = createCodexOAuthClient(mock.fetch);
    const fresh = await client.refresh('OLD_RT');
    expect(fresh.accessToken).toBe('AT2');
    expect(fresh.refreshToken).toBe('RT2');

    const req = mock.requests[0];
    expect(req.url).toBe(CODEX_TOKEN_URL);
    expect(req.body).toContain('grant_type=refresh_token');
    expect(req.body).toContain('refresh_token=OLD_RT');
    expect(req.body).toContain('client_id=' + CODEX_CLIENT_ID);
  });

  test('refresh throws on non-200', async () => {
    const mock = createMockFetch([
      { match: 'oauth/token', respond: { status: 401, body: { error: 'invalid_grant' } } },
    ]);
    const client = createCodexOAuthClient(mock.fetch);
    await expect(client.refresh('BAD')).rejects.toThrow(/token refresh failed/);
  });

  test('tokensToCredential wraps tokens + metadata', () => {
    const cred = tokensToCredential({
      accessToken: 'AT', refreshToken: 'RT', expiresAt: 12345,
    }, { accountId: 'acct-abc' });
    expect(cred.kind).toBe('oauth');
    if (cred.kind !== 'oauth') return;
    expect(cred.accessToken).toBe('AT');
    expect(cred.refreshToken).toBe('RT');
    expect(cred.expiresAt).toBe(12345);
    expect(cred.metadata?.accountId).toBe('acct-abc');
  });
});
