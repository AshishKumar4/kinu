import { describe, expect, test } from 'bun:test';
import { createTestRuntime } from '@kinu.run/test-utils';
import { buildSystemPromptSync, type SystemPromptOptions } from '../src/prompt';
import { estimateTokens } from '../src/llm';
import { BUILTIN_ROLE_DEFINITIONS } from '../src/profiles/catalog';
import { resolvePromptModelProfile, type PromptModelContext, type PromptModelFamily } from '../src/prompting/model-profile';
import { LEAD_BRIEF, OPERATING_GUIDANCE, PROMPT_SECTIONS } from '../src/prompting/section-templates';
import { PROMPT_MATRIX } from './fixtures/prompt-surface-matrix';

const MODELS: Readonly<Record<PromptModelFamily, PromptModelContext>> = {
  kimi: { id: 'kimi-k3-instruct', provider: 'moonshot' },
  gpt: { id: 'gpt-5-codex', provider: 'openai' },
  claude: { id: 'claude-sonnet-4-7', provider: 'anthropic' },
  gemini: { id: 'gemini-3-pro', provider: 'google' },
  generic: { id: 'unknown-model', provider: 'other' },
};

const full = PROMPT_MATRIX.find(({ name }) => name === 'cf-full-surface');

if (!full) throw new Error('Full prompt proof surface is missing');

// Upper-bound fixture; mutually exclusive arms are covered in PROMPT_MATRIX.
const ALL_SECTIONS: SystemPromptOptions = {
  ...full.opts,
  identity: { workspace: 'Budget workspace', agent: 'Budget actor' },
  roleSection: { id: 'task', label: 'Task', instructions: BUILTIN_ROLE_DEFINITIONS.task.instructions },

  externalTools: [{ name: 'docs.search', source: 'mcp', description: 'Search connected documentation.' }],
  executors: full.opts.executors?.map((executor) => ({ ...executor, capabilities: ['net_inbound'] })),
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

  test('only the selected family adds its paragraphs; Claude and unknown models keep the shared base', () => {
    const { rt } = createTestRuntime();

    for (const [family, model] of Object.entries(MODELS)) {
      const prompt = buildSystemPromptSync(rt, { ...full.opts, model });

      expect(prompt.includes('Concrete implementation packets')).toBe(family === 'gpt');
      expect(prompt.includes('Do something different from looped content.')).toBe(family === 'gemini');
      expect(prompt.includes('Kimi models work best')).toBe(family === 'kimi');
      expect(prompt.includes('GPT/Codex-style reasoning models')).toBe(family === 'gpt');
    }

    const withoutModel = (model: PromptModelContext) => buildSystemPromptSync(rt, { ...full.opts, model })
      .replace(/^- Model: .*$/mu, '');

    expect(withoutModel(MODELS.claude)).toBe(withoutModel(MODELS.generic));
  });

  test('a store-sourced replacement composes with the selected family delta, changing only its own section', () => {
    const { rt } = createTestRuntime();
    const opts = { ...full.opts, model: MODELS.gpt };
    const baseline = buildSystemPromptSync(rt, opts);

    for (const section of [OPERATING_GUIDANCE, LEAD_BRIEF]) {
      const heading = section.source.split('\n')[0];

      if (!heading) throw new Error(`Missing heading: ${section.id}`);
      const replacement = section.source.replace('## ', '## Evolved ');

      const prompt = buildSystemPromptSync(rt, {
        ...opts, sectionOverrides: { [section.id]: replacement },
      });

      expect(prompt).toBe(baseline.replace(heading, heading.replace('## ', '## Evolved ')));
      expect(prompt).toContain('Concrete implementation packets');
      expect(prompt).toContain('GPT/Codex-style reasoning models');
    }
  });
});

test('every full family prompt stays within 10,000 context-budget tokens', () => {
  const { rt } = createTestRuntime();

  // estimateTokens is ceil(chars / 4), not a model tokenizer.
  const totals = Object.entries(MODELS).map(([family, model]) => {
    const prompt = buildSystemPromptSync(rt, { ...ALL_SECTIONS, model });

    for (const section of PROMPT_SECTIONS) {
      const heading = /^## [^\n{]*/u.exec(section.source)?.[0];

      if (!heading) throw new Error(`Missing heading: ${section.id}`);
      expect(prompt).toContain(heading);
    }

    return { family, tokens: estimateTokens(prompt.length), chars: prompt.length };
  });

  for (const total of totals) {
    expect({ ...total, withinBudget: total.tokens <= 10_000 })
      .toEqual({ ...total, withinBudget: true });
  }

  process.stdout.write(totals.map(({ family, tokens, chars }) =>
    `system-prompt budget: ${family} ${tokens} estimated tokens (${chars} chars; ceil(chars/4))`).join('\n') + '\n');
});
