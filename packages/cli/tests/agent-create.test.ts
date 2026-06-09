import { describe, expect, test } from 'bun:test';
import { createAgentNameFromMission, suggestAgentIdentityFromMission } from '../src/agent-create';

describe('CLI mission agent names', () => {
  test('uses the shared generic fallback and a stable id suffix', () => {
    expect(createAgentNameFromMission('Research Rust web frameworks', 'abcdef123456'))
      .toBe('agent-abcdef');
    expect(createAgentNameFromMission('!!!', '123456abcdef'))
      .toBe('agent-123456');
  });

  test('uses model-proposed title and slug for mission-created agents', async () => {
    const identity = await suggestAgentIdentityFromMission(
      'Build a benchmark for Rust web frameworks',
      {
        id: 'abcdef123456',
        generate: async () => JSON.stringify({
          title: 'Rust Framework Benchmark',
          slug: 'rust-framework-benchmark',
        }),
      },
    );

    expect(identity).toEqual({
      name: 'rust-framework-benchmark-abcdef',
      displayName: 'Rust Framework Benchmark',
      nameOrigin: 'auto',
    });
  });

  test('falls back without deriving names from prompt words when model naming is unavailable', async () => {
    const identity = await suggestAgentIdentityFromMission(
      'Review the OAuth callback flow',
      { id: '123456abcdef', generate: async () => { throw new Error('offline'); } },
    );

    expect(identity).toEqual({
      name: 'agent-123456',
      displayName: 'Agent',
      nameOrigin: 'auto',
    });
  });
});
