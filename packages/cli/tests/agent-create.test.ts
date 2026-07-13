import { describe, expect, test } from 'bun:test';
import { createWorkspaceNameFromMission, suggestAgentIdentityFromMission } from '../src/agent-create';

describe('CLI mission workspace names', () => {
  test('uses the shared memorable fallback and a stable id suffix', () => {
    expect(createWorkspaceNameFromMission('Research Rust web frameworks', 'abcdef123456'))
      .toBe('evergreen-birch-abcd');
    expect(createWorkspaceNameFromMission('!!!', '123456abcdef'))
      .toBe('ironwood-elm-1234');
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
      name: 'ironwood-elm-1234',
      displayName: 'Ironwood Elm',
      nameOrigin: 'auto',
    });
  });
});
