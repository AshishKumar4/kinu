/** One spelling, one route: a model spec normalises and lists alike on the cf registry and the CLI resolver. */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_WORKERS_AI_MODEL_ID } from '@kinu.run/core';
import { createAgentProviderRegistry } from '../../src/providers/agent-registry';
import { createLocalModelResolver } from '../../../cli-backend/src/model-resolver';
import { userCredentialSource } from '../helpers/user-credentials';

const cf = createAgentProviderRegistry({
  env: {},
  userDO: userCredentialSource({
    getAuthHeaders: async () => null, listCredentials: async () => [], getCredentialBaseURL: async () => null,
  }),
});

/** A shell command a message would send the reader to run. */
const COMMAND = /\b(?:kinu|opencode|wrangler) (?:auth|setup|provider|login|create)\b/;

/** A machine whose default is Workers AI behind its own gateway endpoint. */
const cli = createLocalModelResolver({
  llm: { name: 'workers-ai', baseURL: 'http://127.0.0.1:9/v1', headers: { Authorization: 'Bearer t' }, model: DEFAULT_WORKERS_AI_MODEL_ID },
  credentials: {},
});

describe('a model spec on both backends', () => {
  test('normalises to the same route', () => {
    for (const named of ['@cf/meta/llama-4-scout', 'minimax/m3', 'openai/gpt-5', 'claude/claude-opus-4-7']) {
      expect({ named, spec: cli.normalizeSpecSync(named) }).toEqual({ named, spec: cf.normalizeSpecSync(named) });
    }
  });

  test('refuses a head no provider claims instead of reading it as a model id', () => {
    expect(() => cf.normalizeSpecSync('Qwen/Qwen3-8B')).toThrow('Unknown provider in model spec "Qwen/Qwen3-8B"');
    expect(() => cli.normalizeSpecSync('Qwen/Qwen3-8B')).toThrow('Unknown provider in model spec "Qwen/Qwen3-8B"');
  });

  test('lists the providers both register in one order, the preference judge selection reads', async () => {
    const cfOrder = (await cf.registry.listProviders(cf.deps)).map((provider) => provider.id);
    const cliOrder = (await cli.listProviders()).map((provider) => provider.id);

    expect(cliOrder.filter((id) => cfOrder.includes(id))).toEqual(cfOrder.filter((id) => cliOrder.includes(id)));
  });

  test('says what is missing when a provider is unavailable, never a command to run', async () => {
    // A cf workspace with no relayed machine, and a machine signed out of Kinu with nothing connected.
    const signedOut = createLocalModelResolver({ llm: null, credentials: {} });

    const reasons = [...await cf.registry.listProviders(cf.deps), ...await signedOut.listProviders()]
      .flatMap((provider) => (provider.unavailableReason === undefined ? [] : [`${provider.id}: ${provider.unavailableReason}`]));

    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.filter((reason) => COMMAND.test(reason))).toEqual([]);
    expect(() => signedOut.normalizeSpecSync(null)).toThrow(expect.objectContaining({ message: expect.not.stringMatching(COMMAND) }));
  });
});
