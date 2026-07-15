import { describe, test, expect } from 'bun:test';
import { DEFAULT_WORKERS_AI_MODEL_SPEC } from '@proteus/core';
import {
  contextWindowForSpec,
  dedupeModelEntries,
  filterModels,
  normalizeModelEntries,
  validateModelSpec,
  type AgentModelEntry,
} from '../src/model-catalog.js';

const FEED: AgentModelEntry[] = [
  { spec: 'workers-ai/@cf/meta/llama-4', label: 'Llama 4', provider: 'workers-ai' },
  { spec: DEFAULT_WORKERS_AI_MODEL_SPEC, label: 'Kimi K2.6', provider: 'workers-ai', contextWindow: 131072 },
  { spec: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'anthropic', contextWindow: 1_000_000 },
  { spec: 'groq/llama-3.3-70b-versatile', label: 'Llama 3.3 70B', provider: 'groq' },
  { spec: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic' },
];

describe('dedupeModelEntries', () => {
  test('pins the platform default, then groups providers in feed order', () => {
    const out = dedupeModelEntries(FEED);
    expect(out.map((m) => m.spec)).toEqual([
      DEFAULT_WORKERS_AI_MODEL_SPEC,
      'workers-ai/@cf/meta/llama-4',
      'anthropic/claude-haiku-4-5',
      'anthropic/claude-opus-4-7',
      'groq/llama-3.3-70b-versatile',
    ]);
  });

  test('collapses duplicate specs and unions capabilities', () => {
    const out = dedupeModelEntries([
      { spec: 'groq/m', label: 'M', provider: 'groq', capabilities: ['tools'] },
      { spec: 'groq/m', label: 'M', provider: 'groq', capabilities: ['vision'] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].capabilities?.sort()).toEqual(['tools', 'vision']);
  });
});

describe('normalizeModelEntries + contextWindowForSpec', () => {
  test('keeps contextWindow through normalization and looks it up by spec', () => {
    const rows = normalizeModelEntries([
      { spec: 'groq/llama-3.3-70b-versatile', label: 'Llama 3.3 70B', provider: 'groq', contextWindow: 131072 },
    ]);
    expect(contextWindowForSpec(rows, 'groq/llama-3.3-70b-versatile')).toBe(131072);
    expect(contextWindowForSpec(rows, 'missing/spec')).toBeUndefined();
  });

  test('maps local resolver rows (provider + id) to picker entries with metadata', () => {
    // The exact shape LocalAgentClient.listModels feeds /model: the signed-in
    // resolver lists ModelInfo rows under their provider id.
    const rows = normalizeModelEntries([
      {
        provider: 'workers-ai', id: '@cf/moonshotai/kimi-k2.6', label: 'Kimi K2.6',
        capabilities: ['tools', 'streaming'], contextWindow: 262144,
      },
      { provider: 'my-gateway', id: 'openai/gpt-4.1', label: 'GPT-4.1', contextWindow: 1047576 },
    ]);
    expect(rows).toEqual([
      {
        spec: DEFAULT_WORKERS_AI_MODEL_SPEC, label: 'Kimi K2.6', provider: 'workers-ai',
        capabilities: ['tools', 'streaming'], contextWindow: 262144,
      },
      {
        spec: 'my-gateway/openai/gpt-4.1', label: 'GPT-4.1', provider: 'my-gateway',
        capabilities: undefined, contextWindow: 1047576,
      },
    ]);
  });
});

describe('filterModels', () => {
  test('an empty query keeps the full model list', () => {
    expect(filterModels(FEED, '')).toEqual(FEED);
    expect(filterModels(FEED, '   ')).toEqual(FEED);
  });

  test('filters case-insensitively across labels, providers, specs, and capabilities', () => {
    const models: AgentModelEntry[] = [
      { spec: 'workers-ai/@cf/meta/llama-4', label: 'Llama 4', provider: 'workers-ai', capabilities: ['tools'] },
      { spec: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'anthropic', capabilities: ['vision'] },
    ];

    expect(filterModels(models, 'OPUS')).toEqual([models[1]]);
    expect(filterModels(models, 'anthropic')).toEqual([models[1]]);
    expect(filterModels(models, '@CF/META')).toEqual([models[0]]);
    expect(filterModels(models, 'VISION')).toEqual([models[1]]);
  });
});

describe('validateModelSpec', () => {
  test('distinguishes catalog models, uncatalogued models, and unknown providers', () => {
    expect(validateModelSpec(FEED, 'anthropic/claude-opus-4-7')).toEqual({ status: 'known' });
    expect(validateModelSpec(FEED, 'anthropic/claude-opus-4-8')).toEqual({
      status: 'unknown-model',
      provider: 'anthropic',
      suggestions: ['anthropic/claude-opus-4-7', 'anthropic/claude-haiku-4-5'],
    });
    expect(validateModelSpec(FEED, 'unknown/model')).toEqual({
      status: 'unknown-provider',
      provider: 'unknown',
      providers: ['anthropic', 'groq', 'workers-ai'],
    });
    expect(validateModelSpec(FEED, 'bare-model')).toEqual({
      status: 'unknown-provider',
      provider: 'bare-model',
      providers: ['anthropic', 'groq', 'workers-ai'],
    });
  });
});
