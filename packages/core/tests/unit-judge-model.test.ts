/** Judge-model selection: prefer a different vendor so the agent never grades itself with itself. */

import { describe, test, expect } from 'bun:test';
import { modelVendorFamily, selectEnsembleJudges, selectJudgeModel } from '../src/index';

const noCandidates = async () => [];

describe('modelVendorFamily', () => {
  test('reads the vendor segment out of every id shape the registry produces', () => {
    expect(modelVendorFamily('workers-ai/@cf/moonshotai/kimi-k2.6')).toBe('moonshotai');
    expect(modelVendorFamily('openrouter/moonshotai/kimi-k3')).toBe('moonshotai');
    // The gateway nests the whole workers-ai spec inside its own model id.
    expect(modelVendorFamily('ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.6')).toBe('moonshotai');
    expect(modelVendorFamily('workers-ai/@cf/openai/gpt-oss-120b')).toBe('openai');
  });

  const FAMILIES = [
    {
      name: 'falls back to the provider id when the model id names no vendor',
      routes: [['openai/gpt-5.5', 'openai'], ['anthropic/claude-opus-4-7', 'anthropic']],
    },
    {
      name: 'two routes to the same build are the same family',
      routes: [
        ['workers-ai/@cf/moonshotai/kimi-k2.6', 'moonshotai'],
        ['openrouter/moonshotai/kimi-k2.6', 'moonshotai'],
      ],
    },
  ];

  for (const family of FAMILIES) {
    test(family.name, () => {
      for (const [id, vendor] of family.routes) expect(modelVendorFamily(id)).toBe(vendor);
    });
  }

  test('resellers report the vendor they resell, not their own id', () => {
    // Codex is OpenAI's own endpoint: GPT judging GPT is not cross-family however it is billed.
    expect(modelVendorFamily('codex/gpt-5.5')).toBe('openai');
  });
});

describe('selectJudgeModel', () => {
  test('an explicit review model wins outright and skips the availability query', async () => {
    let queried = false;

    const selection = await selectJudgeModel({
      reviewSpec: 'anthropic/claude-haiku-4-5',
      chatSpec: 'workers-ai/@cf/moonshotai/kimi-k2.6',
      candidates: async () => {
        queried = true;

        return ['openai/gpt-5.5'];
      },
    });

    expect(selection).toEqual({ spec: 'anthropic/claude-haiku-4-5', source: 'configured' });
    expect(queried).toBe(false);
  });

  test('an explicit same-family review model is still honoured', async () => {
    const selection = await selectJudgeModel({
      reviewSpec: 'openrouter/moonshotai/kimi-k2.6',
      chatSpec: 'workers-ai/@cf/moonshotai/kimi-k2.6',
      candidates: noCandidates,
    });

    expect(selection.source).toBe('configured');
  });

  test('with no review model, picks the first different-vendor candidate in order', async () => {
    const selection = await selectJudgeModel({
      reviewSpec: null,
      chatSpec: 'workers-ai/@cf/moonshotai/kimi-k2.6',
      candidates: async () => [
        'workers-ai/@cf/moonshotai/kimi-k2.6',
        'openrouter/moonshotai/kimi-k3',
        'anthropic/claude-opus-4-7',
        'openai/gpt-5.5',
      ],
    });

    expect(selection).toEqual({ spec: 'anthropic/claude-opus-4-7', source: 'cross-family' });
  });

  test('blank review models are treated as unset, not as a spec', async () => {
    const selection = await selectJudgeModel({
      reviewSpec: '   ',
      chatSpec: 'workers-ai/@cf/moonshotai/kimi-k2.6',
      candidates: async () => ['openai/gpt-5.5'],
    });

    expect(selection).toEqual({ spec: 'openai/gpt-5.5', source: 'cross-family' });
  });

  test('falls back to the chat model when every candidate is the same vendor', async () => {
    const selection = await selectJudgeModel({
      reviewSpec: undefined,
      chatSpec: 'openai/gpt-5.5',
      candidates: async () => ['codex/gpt-5.5', 'openai/gpt-5.4'],
    });

    expect(selection).toEqual({ spec: 'openai/gpt-5.5', source: 'same-family-fallback' });
  });

  test('falls back to the chat model when nothing else is connected', async () => {
    const selection = await selectJudgeModel({
      reviewSpec: null,
      chatSpec: 'workers-ai/@cf/moonshotai/kimi-k2.6',
      candidates: noCandidates,
    });

    expect(selection.source).toBe('same-family-fallback');
    expect(selection.spec).toBe('workers-ai/@cf/moonshotai/kimi-k2.6');
  });
});

describe('selectEnsembleJudges', () => {
  test('takes one judge per vendor family, in registry order', async () => {
    const selection = await selectEnsembleJudges({
      specs: null,
      chatSpec: () => 'workers-ai/@cf/moonshotai/kimi-k2.6',
      candidates: async () => [
        'anthropic/claude-fable-5',
        'openrouter/anthropic/claude-fable-5',
        'codex/gpt-5.6-sol',
        'openai/gpt-5.5',
      ],
    });

    expect(selection).toEqual({
      specs: ['anthropic/claude-fable-5', 'codex/gpt-5.6-sol'],
      source: 'cross-family',
    });
  });

  test('never draws a judge from the family the classifier runs on', async () => {
    const selection = await selectEnsembleJudges({
      specs: null,
      chatSpec: () => 'openai/gpt-5.5',
      candidates: async () => ['codex/gpt-5.6-sol', 'anthropic/claude-fable-5', 'workers-ai/@cf/moonshotai/kimi-k3'],
    });

    expect(selection.specs).toEqual(['anthropic/claude-fable-5', 'workers-ai/@cf/moonshotai/kimi-k3']);
  });

  test('named judges win outright, without an availability query or a spec resolution', async () => {
    // Both are credentialed reads; a named panel must consult neither.
    let queried = false;
    let resolved = false;

    const selection = await selectEnsembleJudges({
      specs: ['anthropic/claude-fable-5', ' codex/gpt-5.6-sol ', '  '],
      chatSpec: () => {
        resolved = true;

        return 'openai/gpt-5.5';
      },
      candidates: async () => {
        queried = true;

        return [];
      },
    });

    expect(selection).toEqual({
      specs: ['anthropic/claude-fable-5', 'codex/gpt-5.6-sol'],
      source: 'configured',
    });
    expect(queried).toBe(false);
    expect(resolved).toBe(false);
  });

  test('resolves the chat spec exactly once when it does have to choose', async () => {
    // Control: the family thunk must still be called on the path that needs it.
    let calls = 0;

    const selection = await selectEnsembleJudges({
      specs: null,
      chatSpec: () => {
        calls += 1;

        return 'openai/gpt-5.5';
      },
      candidates: async () => ['codex/gpt-5.6-sol', 'anthropic/claude-fable-5'],
    });

    expect(calls).toBe(1);
    expect(selection.specs).toEqual(['anthropic/claude-fable-5']);
  });

  test('comes back short rather than inventing a second judge', async () => {
    // No same-family fallback: two models from one vendor agree for reasons that are not the turn.
    const selection = await selectEnsembleJudges({
      specs: null,
      chatSpec: () => 'workers-ai/@cf/moonshotai/kimi-k2.6',
      candidates: async () => ['openai/gpt-5.5', 'codex/gpt-5.4'],
    });

    expect(selection.specs).toEqual(['openai/gpt-5.5']);
    expect((await selectEnsembleJudges({
      specs: [], chatSpec: () => 'openai/gpt-5.5', candidates: noCandidates,
    })).specs).toEqual([]);
  });
});
