/** Adapter half of cross-family judge panels (policy is core's): candidates track connected credentials. */

import { describe, test, expect } from 'bun:test';
import { DEFAULT_WORKERS_AI_MODEL_SPEC } from '@kinu.run/core';
import { userCredentialSource } from './helpers/user-credentials';
import { createMockFetch } from '@kinu.run/test-utils';
import { createAgentProviderRegistry } from '../src/providers/agent-registry';
import { resolveEnsembleJudgeSelection } from '../src/providers/judge-model';

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

describe('resolveEnsembleJudgeSelection', () => {
  test('candidates come from connected credentials, in registry order', async () => {
    const panel = async (...keys: string[]) => (await resolveEnsembleJudgeSelection({
      registry: registryWith(...keys), specs: null, chatSpec: DEFAULT_WORKERS_AI_MODEL_SPEC,
    })).specs;

    expect(await panel('cloudflare.oauth')).toEqual([]);
    expect(await panel('cloudflare.oauth', 'anthropic.bearer')).toEqual(['anthropic/claude-opus-4-7']);
    expect(await panel('cloudflare.oauth', 'anthropic.bearer', 'openai.bearer')).toEqual(['openai/gpt-5.5', 'anthropic/claude-opus-4-7']);
  });

  test('a GPT chat model refuses the Codex reseller and keeps looking', async () => {
    const selection = await resolveEnsembleJudgeSelection({
      registry: registryWith('cloudflare.oauth', 'codex.oauth', 'openai.bearer', 'anthropic.bearer'),
      specs: null,
      chatSpec: 'openai/gpt-5.5',
    });

    expect(selection.specs).toEqual([DEFAULT_WORKERS_AI_MODEL_SPEC, 'anthropic/claude-opus-4-7']);
  });

  test('named judges are normalized', async () => {
    const selection = await resolveEnsembleJudgeSelection({
      registry: registryWith('cloudflare.oauth', 'anthropic.bearer'),
      specs: ['@cf/openai/gpt-oss-120b'],
      chatSpec: KIMI,
    });

    expect(selection).toEqual({ specs: ['workers-ai/@cf/openai/gpt-oss-120b'], source: 'configured' });
  });
});
