/**
 * The scripted provider's boundary: it exists only where the test var asked.
 *
 * `tests/e2e/two-turns.e2e.test.ts` boots `wrangler dev` with
 * `KINU_SCRIPTED_MODEL=1` so a real OrchestratorAgent turn has a model that
 * calls nothing external. The property this file pins is the other direction:
 * a deployment — which never carries the var — must refuse `scripted/<id>` at
 * normalization, before any workspace persists it. Registered-but-throwing is
 * the wrong refusal (the spec survives into `setModel` and fails mid-turn);
 * unregistered is the right one, and the row below holds exactly that.
 */
import { describe, expect, test } from 'bun:test';
import { generateText } from 'ai';
import { userCredentialSource } from './helpers/user-credentials';
import { createAgentProviderRegistry } from '../src/providers/agent-registry';
import { SCRIPTED_MODEL_ENV } from '../src/providers/scripted';

const noCredentials = userCredentialSource({
  getAuthHeaders: async () => null,
  hasCredential: async () => false,
  listCredentials: async () => [],
  getCredentialBaseURL: async () => null,
});

describe('the scripted provider', () => {
  test('is refused without KINU_SCRIPTED_MODEL, as any unknown provider is', () => {
    const reg = createAgentProviderRegistry({ env: {}, userDO: noCredentials });

    expect(reg.registry.get('scripted')).toBeUndefined();
    expect(() => reg.normalizeSpecSync('scripted/echo')).toThrow(/Unknown provider/);
    expect(() => reg.resolveModel('scripted/echo')).toThrow(/Unknown provider/);
  });

  test('registers and echoes the last user message when the var opts in', async () => {
    const reg = createAgentProviderRegistry({
      env: { [SCRIPTED_MODEL_ENV]: '1' },
      userDO: noCredentials,
    });

    expect(reg.normalizeSpecSync('scripted/echo')).toBe('scripted/echo');

    const { text } = await generateText({
      model: reg.resolveModel('scripted/echo'),
      prompt: 'the message this turn was started with',
    });

    expect(text).toBe('echo:the message this turn was started with');
  });
});
