// Regression tests for the Workers AI credential lifecycle.
//
// The owner's daily "Connect Cloudflare Workers AI" reauth came from an
// access-token-only credential (no offline_access scope → no refresh token)
// dying at expiry. These tests pin the whole silent-refresh path: rotated
// tokens merge into the stored credential, a mid-flight 401 forces one
// refresh-and-retry, and an expired-but-refreshable credential still
// advertises Workers AI (so the connect CTA stays a fallback, not a ritual).
import { describe, test, expect } from 'bun:test';
import { userCredentialSource } from './helpers/user-credentials';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateText } from 'ai';
import { createAgentProviderRegistry } from '../src/providers/agent-registry';
import { CloudflareOAuthTokenError, refreshCloudflareCredential } from '../src/lib/cloudflare-oauth';
import { asFetchFunction } from '@kinu.run/core';
import * as v from 'valibot';


/** What a rejected `generateText` hands back: the AI SDK's error, whose
 *  `message` and `responseBody` are the two places the owner-visible text can
 *  land. Parsed rather than asserted — a rejection is an I/O boundary. */
const ModelRejectionSchema = v.looseObject({
  message: v.optional(v.string()),
  responseBody: v.optional(v.string()),
});
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

describe('Workers AI credential refresh', () => {
  test('refresh merges rotated tokens into the stored credential shape', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://dash.cloudflare.com/oauth2/token');
      const body = new URLSearchParams(String(init?.body));
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
        expect(cause).toBeInstanceOf(CloudflareOAuthTokenError);
        const parsed = v.safeParse(v.object({ oauthError: v.string() }), cause);
        expect(parsed.success && parsed.output.oauthError).toBe('invalid_grant');
      }
      expect(rejected).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a mid-flight 401 forces one refresh and retries with the fresh token', async () => {
    const authCalls: Array<boolean> = [];
    const stub = userCredentialSource({
      getAuthHeaders: async (key: string, opts?: { forceRefresh?: boolean }) => {
        if (key !== 'cloudflare.oauth') return null;
        authCalls.push(!!opts?.forceRefresh);
        return { authorization: opts?.forceRefresh ? 'Bearer cf-fresh' : 'Bearer cf-stale' };
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
      model: reg.resolveModel('workers-ai/@cf/moonshotai/kimi-k2.6'),
      prompt: 'ping',
    });
    expect(result.text).toBe('ok');
    expect(wire).toEqual(['Bearer cf-stale', 'Bearer cf-fresh']);
    expect(authCalls).toEqual([false, true]);
  });

  test('a 401 that SURVIVES the refresh says what to do, not the word "Unauthorized"', async () => {
    // Production, 2026-08-17: six runs across `stone-ash-71f2` and
    // `sunlit-stone-4a20` ended `run_end {reason:'error', error:'Unauthorized'}`
    // and the chat's failed-turn card printed that single word. Cloudflare
    // answers a rejected credential with the plain text `Unauthorized`, and the
    // shared fetch passed non-ok responses to `mapError` — which `workers-ai.ts`
    // does not supply — so the raw body went to the model client untouched. The
    // actionable sentence existed the whole time, in the gateway mapper only.
    const stub = userCredentialSource({
      getAuthHeaders: async (key: string) => (
        key === 'cloudflare.oauth' ? { authorization: 'Bearer cf-dead' } : null
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

    // `String(err)` on an AI SDK error is just its NAME — asserting against
    // that would make the negative below unable to fail, which is the same as
    // not having it. The body the owner is shown is `responseBody`/`message`.
    let failure = '';
    try {
      await generateText({
        model: reg.resolveModel('workers-ai/@cf/moonshotai/kimi-k2.6'),
        prompt: 'ping',
      });
    } catch (cause) {
      const parsed = v.safeParse(ModelRejectionSchema, cause);
      failure = parsed.success
        ? `${parsed.output.message ?? ''}\n${parsed.output.responseBody ?? ''}`
        : String(cause);
    }

    expect(failure).toContain('Reconnect Cloudflare in User settings');
    // The bare upstream word is what the owner was shown; it must not survive.
    expect(failure).not.toMatch(/(^|\W)Unauthorized(\W|$)/);
    // Still exactly one forced-refresh retry — the fix reports the failure, it
    // does not add another attempt against a credential already refused twice.
    expect(attempts).toBe(2);
  });

  test('an unrefreshable credential stops advertising Workers AI (CTA fallback)', async () => {
    // UserDO returns null headers when the credential is expired with no
    // refresh token — the provider must drop out of the model menu so the
    // connect CTA appears, instead of advertising a dead provider.
    const dead = userCredentialSource({
      getAuthHeaders: async () => null,
      listCredentials: async () => [{ key: 'cloudflare.oauth', kind: 'oauth', createdAt: 0, updatedAt: 0 }],
      getCredentialBaseURL: async () => null,
    });
    const reg = createAgentProviderRegistry({ env: {}, userDO: dead });
    expect(await reg.registry.get('workers-ai')!.isAvailable(reg.deps)).toBe(false);

    // …while a credential UserDO can still serve (fresh or silently
    // refreshed) keeps Workers AI advertised — no CTA.
    const alive = userCredentialSource({
      getAuthHeaders: async (key: string) =>
        key === 'cloudflare.oauth' ? { authorization: 'Bearer cf-user-token' } : null,
      listCredentials: async () => [{ key: 'cloudflare.oauth', kind: 'oauth', createdAt: 0, updatedAt: 0 }],
      getCredentialBaseURL: async (key: string) => (key === 'cloudflare.oauth' ? ACCOUNT_BASE_URL : null),
    });
    const reg2 = createAgentProviderRegistry({ env: {}, userDO: alive });
    expect(await reg2.registry.get('workers-ai')!.isAvailable(reg2.deps)).toBe(true);
  });

  test('UserDO refreshes expiring Cloudflare credentials and persists the rotation', () => {
    const userDO = readFileSync(join(import.meta.dir, '..', 'src/user/user-do.ts'), 'utf8');
    // Proactive refresh on use…
    expect(userDO).toContain('opts?.forceRefresh || isCloudflareCredentialExpiring(cred)');
    // …persisted back to storage so the next caller gets the rotated tokens…
    expect(userDO).toContain('refreshCloudflareCredential(this.env, current)');
    expect(userDO).toContain('await this.writeCredential(CLOUDFLARE_OAUTH_CRED_KEY, next);');
    // …and the base-URL gate treats expired-but-refreshable as usable.
    expect(userDO).toContain('if (!isCloudflareCredentialUsable(cred)) return null;');
    // A terminal invalid_grant strips the dead refresh token so the
    // credential stops counting as usable and the connect CTA resurfaces.
    expect(userDO).toContain("err.oauthError === 'invalid_grant'");
    expect(userDO).toContain("if (refreshed === 'revoked') return null;");
  });
});
