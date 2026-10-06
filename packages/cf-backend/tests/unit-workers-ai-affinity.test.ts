// Defends: the x-session-affinity header (prefix-cache pinning) must reach the wire through the
// provider's customFetch; a provider rewrite once dropped it silently.
import { describe, test, expect } from 'bun:test';
import { userCredentialSource } from './helpers/user-credentials';
import { CHAT_COMPLETION_BODY } from '@kinu.run/test-utils';
import { generateText } from 'ai';
import { createAgentProviderRegistry } from '../src/providers/agent-registry';
import { agentAffinityKey, asFetchFunction } from '@kinu.run/core';

const ACCOUNT_BASE_URL = 'https://api.cloudflare.com/client/v4/accounts/abc123abc123abc1/ai/v1';

function fakeUserDOStub() {
  return userCredentialSource({
    getAuthHeaders: async (key: string) =>
      key === 'cloudflare.oauth' ? { authorization: 'Bearer cf-user-token' } : null,
    listCredentials: async () => [{ key: 'cloudflare.oauth', kind: 'oauth', createdAt: 0, updatedAt: 0 }],
    getCredentialBaseURL: async (key: string) => (key === 'cloudflare.oauth' ? ACCOUNT_BASE_URL : null),
  });
}

async function captureWorkersAIRequest(conversation: string) {
  const captured: Array<{ url: string; headers: Headers }> = [];

  const reg = createAgentProviderRegistry({
    env: {},
    userDO: fakeUserDOStub(),
    fetch: asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new Request(input).url;
      captured.push({ url, headers: new Headers(init?.headers) });

      return Response.json(CHAT_COMPLETION_BODY);
    }),
  });

  await generateText({
    model: reg.resolveModel('workers-ai/@cf/moonshotai/kimi-k2.6', conversation),
    prompt: 'ping',
  });
  expect(captured).toHaveLength(1);
  const request = captured[0];

  if (!request) throw new Error('Workers AI request was not captured');

  return request;
}

describe('Workers AI session affinity (REST path)', () => {
  test("the call's conversation is emitted as the x-session-affinity header", async () => {
    const req = await captureWorkersAIRequest(agentAffinityKey('jarvis'));
    expect(req.headers.get('x-session-affinity')).toBe('kinu-jarvis');
    expect(req.headers.get('authorization')).toBe('Bearer cf-user-token');
    expect(req.url.startsWith(`${ACCOUNT_BASE_URL}/`)).toBe(true);
  });

  test('agent-registry model fetches use the patient rate-limit retry', async () => {
    let calls = 0;

    const reg = createAgentProviderRegistry({
      env: {},
      userDO: fakeUserDOStub(),
      fetch: asFetchFunction(async () => {
        calls++;

        return calls === 1
          ? new Response('limited', { status: 429, headers: { 'Retry-After': '0' } })
          : Response.json(CHAT_COMPLETION_BODY);
      }),
    });

    const result = await generateText({
      model: reg.resolveModel('workers-ai/@cf/moonshotai/kimi-k2.6', 'kinu-test'),
      prompt: 'ping',
      maxRetries: 0,
    });

    expect(result.text).toBe('ok');
    expect(calls).toBe(2);
  });
});
