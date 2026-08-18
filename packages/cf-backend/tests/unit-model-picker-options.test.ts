// Pure picker logic — grouping, filtering, badge shaping.
import { describe, test, expect } from 'bun:test';
import { formatContextWindow } from '@proteus/core';
import {
  badgeCapabilities, groupModelMenu, modelMatchesQuery,
} from '../src/components/model-picker-options';
import type { ModelMenuEntry } from '../src/lib/user-api';

const MODELS: ModelMenuEntry[] = [
  { spec: 'workers-ai/@cf/moonshotai/kimi-k2.6', label: 'Kimi K2.6', provider: 'workers-ai', capabilities: ['tools', 'streaming'], contextWindow: 131072 },
  { spec: 'workers-ai/@cf/meta/llama-4', label: 'Llama 4', provider: 'workers-ai', capabilities: ['tools', 'streaming', 'vision'] },
  { spec: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'anthropic', capabilities: ['tools', 'streaming', 'reasoning', 'vision'], contextWindow: 1_000_000 },
  { spec: 'groq/llama-3.3-70b-versatile', label: 'Llama 3.3 70B', provider: 'groq', capabilities: ['tools', 'streaming'], contextWindow: 131072 },
];

describe('groupModelMenu', () => {
  test('groups by provider preserving server (preference) order', () => {
    const groups = groupModelMenu(MODELS);
    expect(groups.map((g) => g.provider)).toEqual(['workers-ai', 'anthropic', 'groq']);
    expect(groups[0].models).toHaveLength(2);
  });

  test('pins the current model: its group first, the entry leading it', () => {
    const groups = groupModelMenu(MODELS, 'groq/llama-3.3-70b-versatile');
    expect(groups[0].provider).toBe('groq');
    expect(groups[0].models[0].spec).toBe('groq/llama-3.3-70b-versatile');
    expect(groups.map((g) => g.provider)).toEqual(['groq', 'workers-ai', 'anthropic']);
  });

  test('pins within a multi-model group without duplicating the entry', () => {
    const groups = groupModelMenu(MODELS, 'workers-ai/@cf/meta/llama-4');
    expect(groups[0].provider).toBe('workers-ai');
    expect(groups[0].models.map((m) => m.label)).toEqual(['Llama 4', 'Kimi K2.6']);
  });

  test('unknown current spec leaves the order untouched', () => {
    const groups = groupModelMenu(MODELS, 'gone/model');
    expect(groups.map((g) => g.provider)).toEqual(['workers-ai', 'anthropic', 'groq']);
  });
});

describe('modelMatchesQuery', () => {
  const claude = MODELS[2];
  test('matches across label, spec, and provider, case-insensitively', () => {
    expect(modelMatchesQuery(claude, 'opus')).toBe(true);
    expect(modelMatchesQuery(claude, 'ANTHROPIC')).toBe(true);
    expect(modelMatchesQuery(claude, 'claude-opus-4-7')).toBe(true);
    expect(modelMatchesQuery(claude, 'gemini')).toBe(false);
  });

  test('every token must match somewhere; empty query matches all', () => {
    expect(modelMatchesQuery(claude, 'anthropic opus')).toBe(true);
    expect(modelMatchesQuery(claude, 'anthropic gemini')).toBe(false);
    expect(modelMatchesQuery(claude, '   ')).toBe(true);
  });
});

describe('formatContextWindow', () => {
  test('compact k/M formatting', () => {
    expect(formatContextWindow(131072)).toBe('131k');
    expect(formatContextWindow(200_000)).toBe('200k');
    expect(formatContextWindow(1_000_000)).toBe('1M');
    expect(formatContextWindow(1_050_000)).toBe('1.05M');
    expect(formatContextWindow(512)).toBe('512');
    expect(formatContextWindow(undefined)).toBeNull();
    expect(formatContextWindow(0)).toBeNull();
  });
});

describe('badgeCapabilities', () => {
  test('surfaces only the differentiators (reasoning/vision)', () => {
    expect(badgeCapabilities(MODELS[2])).toEqual(['reasoning', 'vision']);
    expect(badgeCapabilities(MODELS[0])).toEqual([]);
  });
});
