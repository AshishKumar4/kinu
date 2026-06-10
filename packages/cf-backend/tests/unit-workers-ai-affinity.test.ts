// Regression test for Workers AI session affinity (prefix-cache pinning).
//
// The x-session-affinity header was deliberately wired in the 2026-06-02
// caching session and silently dropped by the OAuth/REST provider rewrite
// (`_opts` unused). This test drives a real generateText call through the
// provider's customFetch and asserts the header reaches the wire, so the
// option can never become decorative again.
import { describe, test, expect } from 'bun:test';
import { generateText } from 'ai';
import { createAgentProviderRegistry } from '../src/providers/agent-registry.ts';
import { agentAffinityKey } from '../src/providers/workers-ai.ts';

const ACCOUNT_BASE_URL = 'https://api.cloudflare.com/client/v4/accounts/abc123abc123abc1/ai/v1';

function fakeUserDOStub() {
  return {
    getAuthHeaders: async (key: string) =>
      key === 'cloudflare.oauth' ? { authorization: 'Bearer cf-user-token' } : null,
    listCredentials: async () => [{ key: 'cloudflare.oauth', kind: 'oauth', createdAt: 0, updatedAt: 0 }],
    getCredentialBaseURL: async (key: string) => (key === 'cloudflare.oauth' ? ACCOUNT_BASE_URL : null),
  } as unknown as Parameters<typeof createAgentProviderRegistry>[0]['userDOStub'];
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
    userDOStub: fakeUserDOStub(),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      captured.push({ url, headers: new Headers(init?.headers) });
      return chatCompletionResponse();
    }) as typeof fetch,
    workersAI,
  });
  await generateText({
    model: reg.resolveModel('workers-ai/@cf/moonshotai/kimi-k2.6'),
    prompt: 'ping',
  });
  expect(captured).toHaveLength(1);
  return captured[0];
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
});
