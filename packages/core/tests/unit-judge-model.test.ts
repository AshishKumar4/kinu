/**
 * Judge-model selection — the self-preference fix. An unset review model used
 * to mean the agent graded itself with itself; the policy here prefers a
 * different vendor whenever one is connected and names the same-vendor case
 * for what it is.
 */

import { describe, test, expect } from 'bun:test';
import { modelVendorFamily, selectJudgeModel } from '../src/index.js';

const noCandidates = async () => [];

describe('modelVendorFamily', () => {
  test('reads the vendor segment out of every id shape the registry produces', () => {
    expect(modelVendorFamily('workers-ai/@cf/moonshotai/kimi-k2.6')).toBe('moonshotai');
    expect(modelVendorFamily('openrouter/moonshotai/kimi-k3')).toBe('moonshotai');
    // The gateway nests the whole workers-ai spec inside its own model id.
    expect(modelVendorFamily('ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.6')).toBe('moonshotai');
    expect(modelVendorFamily('workers-ai/@cf/openai/gpt-oss-120b')).toBe('openai');
  });

  test('falls back to the provider id when the model id names no vendor', () => {
    expect(modelVendorFamily('openai/gpt-5.5')).toBe('openai');
    expect(modelVendorFamily('anthropic/claude-opus-4-7')).toBe('anthropic');
  });

  test('resellers report the vendor they resell, not their own id', () => {
    // Codex is OpenAI's own OAuth endpoint — judging GPT with GPT is not a
    // cross-family pair however the two are billed.
    expect(modelVendorFamily('codex/gpt-5.5')).toBe('openai');
    expect(modelVendorFamily('codex/gpt-5.5')).toBe(modelVendorFamily('openai/gpt-5.5'));
  });

  test('two routes to the same build are the same family', () => {
    expect(modelVendorFamily('workers-ai/@cf/moonshotai/kimi-k2.6'))
      .toBe(modelVendorFamily('openrouter/moonshotai/kimi-k2.6'));
  });
});

describe('selectJudgeModel', () => {
  test('an explicit review model wins outright and skips the availability query', async () => {
    let queried = false;
    const selection = await selectJudgeModel({
      reviewSpec: 'anthropic/claude-haiku-4-5',
      chatSpec: 'workers-ai/@cf/moonshotai/kimi-k2.6',
      candidates: async () => { queried = true; return ['openai/gpt-5.5']; },
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
        'workers-ai/@cf/moonshotai/kimi-k2.6', // same vendor — skipped
        'openrouter/moonshotai/kimi-k3',       // same vendor via another route
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
