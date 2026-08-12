import { describe, expect, test } from 'bun:test';
import {
  createCloudAgentFromMission,
  createWorkspaceNameFromMission,
  suggestAgentIdentityFromMission,
} from '../src/agent-create';
import type { CreateCloudAgentInput } from '../src/cloud-api';

describe('CLI mission workspace names', () => {
  test('derives the name from the mission, memorable pair only for unusable missions', () => {
    expect(createWorkspaceNameFromMission('Research Rust web frameworks', 'abcdef123456'))
      .toBe('research-rust-web-framew-abcdef');
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

  test('derives the fallback from the mission when model naming is unavailable', async () => {
    // Owner-reversed contract (2026-07-15): fallback names must come from the
    // prompt/context, never a random pair, whenever the mission has words.
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

  test('creates an unnamed cloud workspace with the generated name and display name', async () => {
    let createdInput: CreateCloudAgentInput | undefined;
    const created = await createCloudAgentFromMission(
      {
        purpose: 'Build a benchmark for Rust web frameworks',
        model: 'openai/gpt-5-mini',
        reasoningEffort: 'high',
      },
      {
        id: 'abcdef123456',
        generate: async () => JSON.stringify({
          title: 'Rust Framework Benchmark',
          slug: 'rust-framework-benchmark',
        }),
        create: async (input) => {
          createdInput = input;
          return {
            name: input.name ?? 'missing-name',
            displayName: input.displayName ?? 'missing-display-name',
            createdAt: 1,
            lastVisited: 1,
            archivedAt: null,
          };
        },
      },
    );

    expect(createdInput).toEqual({
      name: 'rust-framework-benchmark-abcdef',
      displayName: 'Rust Framework Benchmark',
      purpose: 'Build a benchmark for Rust web frameworks',
      model: 'openai/gpt-5-mini',
      reasoningEffort: 'high',
    });
    expect(created).toMatchObject({
      name: 'rust-framework-benchmark-abcdef',
      displayName: 'Rust Framework Benchmark',
    });
  });

  test('preserves an explicit cloud workspace name', async () => {
    let createdInput: CreateCloudAgentInput | undefined;
    await createCloudAgentFromMission(
      {
        name: 'jarvis',
        displayName: 'Jarvis',
        nameOrigin: 'user',
        purpose: 'Manage my calendar',
      },
      {
        generate: async () => { throw new Error('explicit names must not be regenerated'); },
        create: async (input) => {
          createdInput = input;
          return {
            name: input.name ?? 'missing-name',
            displayName: input.displayName ?? 'missing-display-name',
            createdAt: 1,
            lastVisited: 1,
            archivedAt: null,
          };
        },
      },
    );

    expect(createdInput).toEqual({
      name: 'jarvis',
      displayName: 'Jarvis',
      purpose: 'Manage my calendar',
    });
  });
});
