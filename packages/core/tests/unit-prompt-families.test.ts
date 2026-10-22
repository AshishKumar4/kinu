import { describe, expect, test } from 'bun:test';

import { resolveHarnessSurface, resolvePromptModelProfile, type PromptModelContext, type PromptModelFamily } from '../src/prompting/model-profile';

const MODELS: Readonly<Record<PromptModelFamily, PromptModelContext>> = {
  kimi: { id: 'kimi-k3-instruct', provider: 'moonshot' },
  gpt: { id: 'gpt-5-codex', provider: 'openai' },
  claude: { id: 'claude-sonnet-4-7', provider: 'anthropic' },
  gemini: { id: 'gemini-3-pro', provider: 'google' },
  muse: { id: 'muse-spark-1.3-contributor', provider: 'opencode-go' },
  generic: { id: 'unknown-model', provider: 'other' },
};

describe('family wording is a delta over the same typed sections', () => {
  test('family inference is case-insensitive, with no new capability inference', () => {
    for (const [family, model] of Object.entries(MODELS)) {
      const inferred: string = resolvePromptModelProfile(model).family;

      expect(inferred).toBe(family);
    }

    expect(resolvePromptModelProfile({ id: 'CLAUDE-SONNET', provider: 'openai' }).family).toBe('claude');
    expect(resolvePromptModelProfile({ id: 'GEMINI-PRO' }).family).toBe('gemini');
    expect(resolvePromptModelProfile().family).toBe('generic');
  });

});

// FEAT-2 step 1 (docs/HARNESS-PROFILES.md, "The profile axis"): `auto` resolves as the prompt family does, a claude family
// to claude-code and a gpt one to codex, every other to kinu; a named profile is forced onto any model; native is none.
describe('the harness surface a mode shows a model', () => {
  test('auto follows the family, a named profile is forced, and native stays native', () => {
    const models: readonly PromptModelContext[] = [
      { id: 'claude-opus-5-5', provider: 'anthropic' }, { id: 'gpt-6.1-sol', provider: 'chatgpt' }, { id: 'kimi-k3' }, { id: 'muse-1' }, {},
    ];

    expect({
      auto: models.map((model) => resolveHarnessSurface('auto', model)),
      native: models.map((model) => resolveHarnessSurface('native', model)),
      pi: models.map((model) => resolveHarnessSurface('pi', model)),
    }).toEqual({
      auto: ['claude-code', 'codex', 'kinu', 'kinu', 'kinu'],
      native: ['native', 'native', 'native', 'native', 'native'],
      pi: ['pi', 'pi', 'pi', 'pi', 'pi'],
    });
  });
});
