import { describe, expect, test } from 'bun:test';

import { resolvePromptModelProfile, type PromptModelContext, type PromptModelFamily } from '../src/prompting/model-profile';

const MODELS: Readonly<Record<PromptModelFamily, PromptModelContext>> = {
  kimi: { id: 'kimi-k3-instruct', provider: 'moonshot' },
  gpt: { id: 'gpt-5-codex', provider: 'openai' },
  claude: { id: 'claude-sonnet-4-7', provider: 'anthropic' },
  gemini: { id: 'gemini-3-pro', provider: 'google' },
  muse: { id: 'muse-spark-1.3-contributor', provider: 'opencode-go' },
  generic: { id: 'unknown-model', provider: 'other' },
};

describe('family wording is a delta over the same typed sections', () => {
  test('family inference is catalog-first, case-insensitive, with no new capability inference', () => {
    for (const [family, model] of Object.entries(MODELS)) {
      const inferred: string = resolvePromptModelProfile(model).family;

      expect(inferred).toBe(family);
    }

    expect(resolvePromptModelProfile({ id: 'CLAUDE-SONNET', provider: 'openai' }).family).toBe('claude');
    expect(resolvePromptModelProfile({ id: 'GEMINI-PRO' }).family).toBe('gemini');
    expect(resolvePromptModelProfile({ id: 'gpt', family: 'claude' }).family).toBe('claude');
    expect(resolvePromptModelProfile().family).toBe('generic');

    for (const model of [MODELS.claude, MODELS.gemini]) {
      expect([...resolvePromptModelProfile(model).capabilities]).toEqual(['tools', 'streaming']);
      expect([...resolvePromptModelProfile({ ...model, capabilities: ['vision', 'reasoning'] }).capabilities])
        .toEqual(['vision', 'reasoning']);
    }
  });

});
