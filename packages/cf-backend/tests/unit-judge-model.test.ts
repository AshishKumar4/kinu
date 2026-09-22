/** Adapter half of cross-family judge selection (policy is core's): candidates track connected credentials. */

import { describe, test, expect } from 'bun:test';
import { DEFAULT_WORKERS_AI_MODEL_SPEC } from '@kinu.run/core';
import { userCredentialSource } from './helpers/user-credentials';
import { createMockFetch } from '@kinu.run/test-utils';
import { createAgentProviderRegistry } from '../src/providers/agent-registry';
import { resolveReviewingModelSelection } from '../src/providers/judge-model';

const CLOUDFLARE_BASE = 'https://api.cloudflare.com/client/v4/accounts/acct';

const KIMI = 'workers-ai/@cf/moonshotai/kimi-k2.6';

/** `cloudflare.oauth` needs a baseURL to count as available (what workers-ai checks). */
function registryWith(...keys: string[]) {
  // Stub the models.dev catalog fetch: the live service answers slower than the test timeout.
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

describe('resolveReviewingModelSelection', () => {
  test('a Cloudflare-only owner gets the documented same-vendor fallback', async () => {
    const selection = await resolveReviewingModelSelection({
      registry: registryWith('cloudflare.oauth'),
      pinned: null,
      chatSpec: null, // unset → the workers-ai default
    });

    expect(selection).toEqual({
      spec: DEFAULT_WORKERS_AI_MODEL_SPEC,
      source: 'same-family-fallback',
    });
  });

  test('connecting a second vendor moves judging off the agent\'s own model', async () => {
    const selection = await resolveReviewingModelSelection({
      registry: registryWith('cloudflare.oauth', 'anthropic.bearer'),
      pinned: null,
      chatSpec: null,
    });

    expect(selection.source).toBe('cross-family');
    expect(selection.spec).toBe('anthropic/claude-opus-4-7');
  });

  test('candidates come from connected credentials, not from the static roster', async () => {
    const selection = await resolveReviewingModelSelection({
      registry: registryWith('cloudflare.oauth', 'anthropic.bearer'),
      pinned: null,
      chatSpec: DEFAULT_WORKERS_AI_MODEL_SPEC,
    });

    expect(selection.spec).toBe('anthropic/claude-opus-4-7');

    const withOpenAI = await resolveReviewingModelSelection({
      registry: registryWith('cloudflare.oauth', 'anthropic.bearer', 'openai.bearer'),
      pinned: null,
      chatSpec: DEFAULT_WORKERS_AI_MODEL_SPEC,
    });

    // Registry preference order: openai before anthropic.
    expect(withOpenAI.spec).toBe('openai/gpt-5.5');
  });

  test('a GPT chat model refuses the Codex reseller and keeps looking', async () => {
    const selection = await resolveReviewingModelSelection({
      registry: registryWith('cloudflare.oauth', 'codex.oauth', 'openai.bearer', 'anthropic.bearer'),
      pinned: null,
      chatSpec: 'openai/gpt-5.5',
    });

    expect(selection.spec).toBe(DEFAULT_WORKERS_AI_MODEL_SPEC);
    expect(selection.source).toBe('cross-family');
  });

  test('an explicit review model is honoured and normalized', async () => {
    const selection = await resolveReviewingModelSelection({
      registry: registryWith('cloudflare.oauth', 'anthropic.bearer'),
      pinned: '@cf/openai/gpt-oss-120b',
      chatSpec: KIMI,
    });

    expect(selection).toEqual({ spec: 'workers-ai/@cf/openai/gpt-oss-120b', source: 'configured' });
  });
});
