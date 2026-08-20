import { describe, expect, test } from 'bun:test';
import { workspaceSlug } from '@kinu/core';
import {
  createCloudAgentFromMission,
  suggestAgentIdentityFromMission,
} from '../src/agent-create';
import type { CreateCloudAgentInput } from '../src/cloud-api';

describe('CLI mission workspace names', () => {
  test('uses the model-proposed title, over a slug the model never chose', async () => {
    const identity = await suggestAgentIdentityFromMission(
      'Build a benchmark for Rust web frameworks',
      {
        id: 'abcdef123456',
        generate: async () => JSON.stringify({ title: 'Rust Framework Benchmark' }),
      },
    );

    expect(identity).toEqual({
      name: workspaceSlug('Build a benchmark for Rust web frameworks', 'abcdef123456'),
      displayName: 'Rust Framework Benchmark',
      nameOrigin: 'auto',
    });
  });

  test('derives BOTH names from the mission when model naming is unavailable', async () => {
    // The 2026-07-15 contract — a fallback name must come from the mission,
    // never a random pair — now covers the address too. It did not until
    // 2026-08-16: the slug was `ironwood-elm-1234` here, and the owner reported
    // that shape four times while every fix went to the display name.
    const identity = await suggestAgentIdentityFromMission(
      'Review the OAuth callback flow',
      { id: '123456abcdef', generate: async () => { throw new Error('offline'); } },
    );

    expect(identity).toEqual({
      name: 'review-the-oauth-56abcdef',
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
        generate: async () => JSON.stringify({ title: 'Rust Framework Benchmark' }),
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
      name: workspaceSlug('Build a benchmark for Rust web frameworks', 'abcdef123456'),
      displayName: 'Rust Framework Benchmark',
      purpose: 'Build a benchmark for Rust web frameworks',
      model: 'openai/gpt-5-mini',
      reasoningEffort: 'high',
    });
    expect(created).toMatchObject({
      name: workspaceSlug('Build a benchmark for Rust web frameworks', 'abcdef123456'),
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
