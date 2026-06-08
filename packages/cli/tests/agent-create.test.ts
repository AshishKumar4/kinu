import { describe, expect, test } from 'bun:test';
import { createAgentNameFromMission, suggestAgentIdentityFromMission } from '../src/agent-create';

describe('CLI mission agent names', () => {
  test('uses the shared slug rule and a stable id suffix', () => {
    expect(createAgentNameFromMission('Research Rust web frameworks', 'abcdef123456'))
      .toBe('research-rust-web-framew-abcdef');
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

  test('falls back to a safe automatic title when model naming is unavailable', async () => {
    const identity = await suggestAgentIdentityFromMission(
      'Review the OAuth callback flow',
      { id: '123456abcdef', generate: async () => { throw new Error('offline'); } },
    );

    expect(identity).toEqual({
      name: 'review-the-oauth-callbac-123456',
      displayName: 'Review the OAuth callback flow',
      nameOrigin: 'auto',
    });
  });
});
