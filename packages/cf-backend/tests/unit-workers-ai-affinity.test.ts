// Regression test for Workers AI session affinity (prefix-cache pinning).
//
// The x-session-affinity header was deliberately wired in the 2026-06-02
// caching session and silently dropped by the OAuth/REST provider rewrite
// (`_opts` unused). This test drives a real generateText call through the
// provider's customFetch and asserts the header reaches the wire, so the
// option can never become decorative again.
import { describe, test, expect } from 'bun:test';
import { userCredentialSource } from './helpers/user-credentials.js';
import { generateText } from 'ai';
import { createAgentProviderRegistry } from '../src/providers/agent-registry.ts';
import { agentAffinityKey, asFetchFunction } from '@proteus/core';

const ACCOUNT_BASE_URL = 'https://api.cloudflare.com/client/v4/accounts/abc123abc123abc1/ai/v1';

function fakeUserDOStub() {
  return userCredentialSource({
    getAuthHeaders: async (key: string) =>
      key === 'cloudflare.oauth' ? { authorization: 'Bearer cf-user-token' } : null,
    listCredentials: async () => [{ key: 'cloudflare.oauth', kind: 'oauth', createdAt: 0, updatedAt: 0 }],
    getCredentialBaseURL: async (key: string) => (key === 'cloudflare.oauth' ? ACCOUNT_BASE_URL : null),
  });
}

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

async function captureWorkersAIRequest(workersAI?: { sessionAffinity?: string }) {
  const captured: Array<{ url: string; headers: Headers }> = [];
  const reg = createAgentProviderRegistry({
    env: {},
    userDO: fakeUserDOStub(),
    fetch: asFetchFunction(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new Request(input).url;
      captured.push({ url, headers: new Headers(init?.headers) });
      return chatCompletionResponse();
    }),
    workersAI,
  });
  await generateText({
    model: reg.resolveModel('workers-ai/@cf/moonshotai/kimi-k2.6'),
    prompt: 'ping',
  });
  expect(captured).toHaveLength(1);
  const request = captured[0];
  if (!request) throw new Error('Workers AI request was not captured');
  return request;
}

describe('Workers AI session affinity (REST path)', () => {
  test('agentAffinityKey is the stable proteus-<name> scheme', () => {
    expect(agentAffinityKey('jarvis')).toBe('proteus-jarvis');
  });

  test('sessionAffinity option is emitted as the x-session-affinity header', async () => {
    const req = await captureWorkersAIRequest({ sessionAffinity: agentAffinityKey('jarvis') });
    expect(req.headers.get('x-session-affinity')).toBe('proteus-jarvis');
    // Credential headers and the account-scoped base URL still apply.
    expect(req.headers.get('authorization')).toBe('Bearer cf-user-token');
    expect(req.url.startsWith(`${ACCOUNT_BASE_URL}/`)).toBe(true);
  });

  test('no affinity header without the option (no accidental shared bucket)', async () => {
    const req = await captureWorkersAIRequest(undefined);
    expect(req.headers.get('x-session-affinity')).toBeNull();
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
          : chatCompletionResponse();
      }),
    });

    const result = await generateText({
      model: reg.resolveModel('workers-ai/@cf/moonshotai/kimi-k2.6'),
      prompt: 'ping',
      maxRetries: 0,
    });

    expect(result.text).toBe('ok');
    expect(calls).toBe(2);
  });
});
