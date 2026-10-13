// The Workers AI silent-refresh path: rotated tokens merge into the stored credential, a mid-flight 401 forces
// one refresh-and-retry, and an expired-but-refreshable credential still advertises Workers AI.
import { describe, test, expect } from 'bun:test';
import { userCredentialSource } from './helpers/user-credentials';
import { generateText } from 'ai';
import { createAgentProviderRegistry } from '../src/providers/agent-registry';
import { OAuthTokenError, refreshCloudflareCredential } from '@kinu.run/core';
import { asFetchFunction, reasoningEffortOptions, type AuthRequest } from '@kinu.run/core';
import * as v from 'valibot';
import { bindingModel } from './helpers/workers-ai-model';
import { requestUrl } from '@kinu.run/core';

import { present } from '@kinu.run/test-utils';

const ACCOUNT_BASE_URL = 'https://api.cloudflare.com/client/v4/accounts/abc123abc123abc1/ai/v1';

function chatCompletionResponse(): Response {
  return new Response(JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: '@cf/moonshotai/kimi-k2.6',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { headers: { 'content-type': 'application/json' } });
}

test('configured effort reaches the native Workers AI binding through its SDK transport', async () => {
  const { model, runs } = bindingModel(() => chatCompletionResponse());

  await generateText({ model, prompt: 'probe', maxRetries: 0, providerOptions: reasoningEffortOptions('high', 'workers-ai') });
  expect(runs[0]?.inputs.reasoning_effort).toBe('high');
  expect(runs[0]?.inputs.reasoningEffort).toBeUndefined();
  expect(runs[0]?.inputs.providerOptions).toBeUndefined();
});

describe('Workers AI credential refresh', () => {
  test('refresh merges rotated tokens into the stored credential shape', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(requestUrl(input)).toBe('https://dash.cloudflare.com/oauth2/token');
      const body = new URLSearchParams(await new Request(input, init).text());
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('cf-refresh-1');

      return new Response(JSON.stringify({
        access_token: 'cf-access-2',
        refresh_token: 'cf-refresh-2',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'user-details.read ai.write offline_access',
      }), { headers: { 'content-type': 'application/json' } });
    });

    try {
      const next = await refreshCloudflareCredential(
        { CLOUDFLARE_OAUTH_CLIENT_ID: 'cid', CLOUDFLARE_OAUTH_CLIENT_SECRET: 'csec' },
        {
          kind: 'oauth',
          accessToken: 'cf-access-1',
          refreshToken: 'cf-refresh-1',
          expiresAt: Date.now() - 1_000,
          metadata: { accountId: 'abc123abc123abc1', accountName: 'User Account' },
        },
      );

      expect(next.accessToken).toBe('cf-access-2');
      expect(next.refreshToken).toBe('cf-refresh-2');
      expect(next.expiresAt).toBeGreaterThan(Date.now());
      expect(next.metadata?.accountId).toBe('abc123abc123abc1');
      expect(next.metadata?.scopes).toEqual(['user-details.read', 'ai.write', 'offline_access']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('refresh without a refresh token fails loudly instead of looping', async () => {
    await expect(refreshCloudflareCredential(
      { CLOUDFLARE_OAUTH_CLIENT_ID: 'cid', CLOUDFLARE_OAUTH_CLIENT_SECRET: 'csec' },
      { kind: 'oauth', accessToken: 'cf-access-1' },
    )).rejects.toThrow(/no refresh token/i);
  });

  test('a revoked refresh token surfaces as a typed invalid_grant error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async () => new Response(JSON.stringify({
      error: 'invalid_grant',
      error_description: 'The provided authorization grant is invalid',
    }), { status: 400, headers: { 'content-type': 'application/json' } }));

    try {
      let rejected = false;

      try {
        await refreshCloudflareCredential(
          { CLOUDFLARE_OAUTH_CLIENT_ID: 'cid', CLOUDFLARE_OAUTH_CLIENT_SECRET: 'csec' },
          { kind: 'oauth', accessToken: 'cf-access-1', refreshToken: 'cf-refresh-revoked' },
        );
      } catch (cause) {
        rejected = true;
        expect(cause).toBeInstanceOf(OAuthTokenError);
        const parsed = v.safeParse(v.object({ oauthError: v.string() }), cause);
        expect(parsed.success && parsed.output.oauthError).toBe('invalid_grant');
      }

      expect(rejected).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a mid-flight 401 forces one refresh and retries with the fresh token', async () => {
    const authCalls: Array<string | null> = [];

    const stub = userCredentialSource({
      getAuthHeaders: async (key: string, opts?: AuthRequest) => {
        if (key !== 'cloudflare.oauth') return null;
        authCalls.push(opts?.rejected?.authorization ?? null);

        return { authorization: opts?.rejected === undefined ? 'Bearer cf-stale' : 'Bearer cf-fresh' };
      },
      listCredentials: async () => [{ key: 'cloudflare.oauth', kind: 'oauth', createdAt: 0, updatedAt: 0 }],
      getCredentialBaseURL: async (key: string) => (key === 'cloudflare.oauth' ? ACCOUNT_BASE_URL : null),
    });

    const wire: Array<string | null> = [];

    const reg = createAgentProviderRegistry({
      env: {},
      userDO: stub,
      fetch: asFetchFunction(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        wire.push(headers.get('authorization'));

        if (headers.get('authorization') === 'Bearer cf-stale') {
          return new Response(JSON.stringify({ errors: [{ message: 'Invalid access token' }] }), {
            status: 401, headers: { 'content-type': 'application/json' },
          });
        }

        return chatCompletionResponse();
      }),
    });

    const result = await generateText({
      model: reg.resolveModel('workers-ai/@cf/moonshotai/kimi-k2.6', { sessionAffinity: 'kinu-test', workspaceAffinity: 'kinu-test' }),
      prompt: 'ping',
    });

    expect(result.text).toBe('ok');
    expect(wire).toEqual(['Bearer cf-stale', 'Bearer cf-fresh']);
    expect(authCalls).toEqual([null, 'Bearer cf-stale']);
  });

  test('a 401 that SURVIVES the refresh fails the call after one forced refresh, never more', async () => {
    // Each read rotates the token, as a forced refresh does; Cloudflare refuses every one.
    let issued = 0;

    const stub = userCredentialSource({
      getAuthHeaders: async (key: string) => (
        key === 'cloudflare.oauth' ? { authorization: `Bearer cf-dead-${String(++issued)}` } : null
      ),
      listCredentials: async () => [{ key: 'cloudflare.oauth', kind: 'oauth', createdAt: 0, updatedAt: 0 }],
      getCredentialBaseURL: async (key: string) => (key === 'cloudflare.oauth' ? ACCOUNT_BASE_URL : null),
    });

    let attempts = 0;

    const reg = createAgentProviderRegistry({
      env: {},
      userDO: stub,
      fetch: asFetchFunction(async () => {
        attempts += 1;

        return new Response('Unauthorized', { status: 401, headers: { 'content-type': 'text/plain' } });
      }),
    });

    await expect(generateText({
      model: reg.resolveModel('workers-ai/@cf/moonshotai/kimi-k2.6', { sessionAffinity: 'kinu-test', workspaceAffinity: 'kinu-test' }),
      prompt: 'ping',
    })).rejects.toThrow();
    // Exactly one forced-refresh retry against a credential already refused twice.
    expect(attempts).toBe(2);
  });

  test('an unrefreshable credential stops advertising Workers AI (CTA fallback)', async () => {
    // Null headers (expired, no refresh token) drop the provider so the connect CTA appears.
    const dead = userCredentialSource({
      getAuthHeaders: async () => null,
      listCredentials: async () => [{ key: 'cloudflare.oauth', kind: 'oauth', createdAt: 0, updatedAt: 0 }],
      getCredentialBaseURL: async () => null,
    });

    const reg = createAgentProviderRegistry({ env: {}, userDO: dead });
    expect(await present(reg.registry.get('workers-ai'), 'the workers-ai provider').isAvailable(reg.deps)).toBe(false);

    const alive = userCredentialSource({
      getAuthHeaders: async (key: string) =>
        key === 'cloudflare.oauth' ? { authorization: 'Bearer cf-user-token' } : null,
      listCredentials: async () => [{ key: 'cloudflare.oauth', kind: 'oauth', createdAt: 0, updatedAt: 0 }],
      getCredentialBaseURL: async (key: string) => (key === 'cloudflare.oauth' ? ACCOUNT_BASE_URL : null),
    });

    const reg2 = createAgentProviderRegistry({ env: {}, userDO: alive });
    expect(await present(reg2.registry.get('workers-ai'), 'the workers-ai provider').isAvailable(reg2.deps)).toBe(true);
  });

});
