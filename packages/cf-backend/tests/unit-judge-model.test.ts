/**
 * Cross-family judge selection against a real AgentProviderRegistry.
 *
 * The policy lives in core (unit-judge-model.test.ts in @proteus/core covers
 * it); what is pinned here is the adapter: which specs the registry actually
 * offers up as judge candidates, and that the choice tracks the owner's
 * connected credentials rather than a hardcoded list.
 */

import { describe, test, expect } from 'bun:test';
import { DEFAULT_WORKERS_AI_MODEL_SPEC } from '@proteus/core';
import { userCredentialSource } from './helpers/user-credentials';
import { createMockFetch } from '@proteus/test-utils';
import { createAgentProviderRegistry } from '../src/providers/agent-registry';
import { resolveJudgeModelSelection } from '../src/providers/judge-model';

const CLOUDFLARE_BASE = 'https://api.cloudflare.com/client/v4/accounts/acct';
const KIMI = 'workers-ai/@cf/moonshotai/kimi-k2.6';

/** A registry whose owner has exactly `keys` connected. `cloudflare.oauth`
 *  needs a baseURL to count as available (that is what workers-ai checks). */
function registryWith(...keys: string[]) {
  // The models.dev catalog is fetched to enumerate dynamic providers. Left to
  // the global fetch this reaches the live service, and the suite fails
  // whenever it answers slower than the 5s test timeout — which it does.
  const mock = createMockFetch([
    { match: 'models.dev/api.json', respond: { status: 200, body: {} } },
  ]);
  return createAgentProviderRegistry({
    env: {},
    fetch: mock.fetch,
    userDO: userCredentialSource({
      getAuthHeaders: async (key) => (keys.includes(key) ? { authorization: 'Bearer x' } : null),
      listCredentials: async () => keys.map((key) => ({ key, kind: 'bearer', createdAt: 0, updatedAt: 0 })),
      getCredentialBaseURL: async (key) => (key === 'cloudflare.oauth' ? CLOUDFLARE_BASE : null),
    }),
  });
}

describe('resolveJudgeModelSelection', () => {
  test('a Cloudflare-only owner gets the documented same-vendor fallback', async () => {
    const selection = await resolveJudgeModelSelection({
      registry: registryWith('cloudflare.oauth'),
      reviewSpec: null,
      chatSpec: null, // unset → the workers-ai default, the shipping configuration
    });
    expect(selection).toEqual({
      spec: DEFAULT_WORKERS_AI_MODEL_SPEC,
      source: 'same-family-fallback',
    });
  });

  test('connecting a second vendor moves judging off the agent\'s own model', async () => {
    const selection = await resolveJudgeModelSelection({
      registry: registryWith('cloudflare.oauth', 'anthropic.bearer'),
      reviewSpec: null,
      chatSpec: null,
    });
    expect(selection.source).toBe('cross-family');
    expect(selection.spec).toBe('anthropic/claude-opus-4-7');
  });

  test('candidates come from connected credentials, not from the static roster', async () => {
    // openai is registered ahead of anthropic, but only anthropic is connected.
    const selection = await resolveJudgeModelSelection({
      registry: registryWith('cloudflare.oauth', 'anthropic.bearer'),
      reviewSpec: null,
      chatSpec: DEFAULT_WORKERS_AI_MODEL_SPEC,
    });
    expect(selection.spec).toBe('anthropic/claude-opus-4-7');

    const withOpenAI = await resolveJudgeModelSelection({
      registry: registryWith('cloudflare.oauth', 'anthropic.bearer', 'openai.bearer'),
      reviewSpec: null,
      chatSpec: DEFAULT_WORKERS_AI_MODEL_SPEC,
    });
    // Registry preference order: openai is offered before anthropic.
    expect(withOpenAI.spec).toBe('openai/gpt-5.5');
  });

  test('a GPT chat model refuses the Codex reseller and keeps looking', async () => {
    const selection = await resolveJudgeModelSelection({
      registry: registryWith('cloudflare.oauth', 'codex.oauth', 'openai.bearer', 'anthropic.bearer'),
      reviewSpec: null,
      chatSpec: 'openai/gpt-5.5',
    });
    // Workers AI comes first and its native DeepSeek default is a real
    // cross-vendor jump from GPT.
    expect(selection.spec).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
    expect(selection.source).toBe('cross-family');
  });

  test('an explicit review model is honoured and normalized', async () => {
    const selection = await resolveJudgeModelSelection({
      registry: registryWith('cloudflare.oauth', 'anthropic.bearer'),
      reviewSpec: '@cf/openai/gpt-oss-120b',
      chatSpec: KIMI,
    });
    expect(selection).toEqual({ spec: 'workers-ai/@cf/openai/gpt-oss-120b', source: 'configured' });
  });
});
