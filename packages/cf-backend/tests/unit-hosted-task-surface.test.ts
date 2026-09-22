/**
 * A hired subordinate gets the full-agent surface via `buildActorTools`, and its `memory` and `agents` tools run on its own stores.
 * Defends: delegated turns built from the confined head set. Shape is pinned in tests/conformance.test.ts.
 */
import { expect, test } from 'bun:test';
import { createProviderRegistry, type JsonObject } from '@kinu.run/core';
import { scriptedTurnModel, type ScriptedTurnOptions, type ScriptedTurnResult } from '@kinu.run/test-utils';
import type { MockLanguageModelV3 } from 'ai/test';
import { hostedSubordinateHarness, orchestratorHarness } from './helpers/actor-harness';

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoningId: undefined, reasoning: undefined },
};

const NOTE = 'the streaming parser holds no whole file';

interface ScriptedCall {
  readonly tool: string;
  readonly args: JsonObject;
}

/** Read off the prompt rather than counted in a closure, so a retried request answers the same way. */
const step = (options: ScriptedTurnOptions): number =>
  options.prompt.filter((message) => message.role === 'tool').length;

function turnCalling(calls: readonly ScriptedCall[]): MockLanguageModelV3 {
  return scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-task',
    doGenerate: async (options): Promise<ScriptedTurnResult> => {
      const next = calls[step(options)];

      if (!next) {
        return {
          content: [{ type: 'text' as const, text: 'done' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: USAGE, warnings: [],
        };
      }

      return {
        content: [{
          type: 'tool-call' as const,
          toolCallId: `call-${next.tool}-${String(step(options))}`,
          toolName: next.tool,
          input: JSON.stringify(next.args),
        }],
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage: USAGE, warnings: [],
      };
    },
  });
}

/** A refusal from a missing dep arrives as `error-json`, so the discriminant is kept beside the text. */
interface AnsweredCall {
  readonly tool: string;
  readonly kind: string;
  readonly rendered: string;
}

function toolResults(model: MockLanguageModelV3): AnsweredCall[] {
  const seen = new Map<string, AnsweredCall>();

  for (const call of model.doStreamCalls) {
    for (const message of call.prompt) {
      if (message.role !== 'tool') continue;

      for (const part of message.content) {
        if (part.type !== 'tool-result') continue;
        seen.set(part.toolCallId, {
          tool: part.toolName,
          kind: part.output.type,
          rendered: JSON.stringify(part.output),
        });
      }
    }
  }

  return [...seen.values()];
}

function systemPrompt(model: MockLanguageModelV3): string {
  for (const call of model.doStreamCalls) {
    for (const message of call.prompt) {
      if (message.role === 'system') return message.content;
    }
  }

  throw new Error('the turn issued no request carrying a system prompt');
}

test('a hired subordinate saves and searches memory and lists its roster in its assigned turn', async () => {
  const workspace = orchestratorHarness();

  const child = await hostedSubordinateHarness(workspace, {
    name: 'surface-prover', displayName: 'Surface prover', nameOrigin: 'user',
    mission: 'prove the delegated surface runs',
  });

  const model = turnCalling([
    { tool: 'memory', args: { action: 'save', content: NOTE } },
    { tool: 'memory', args: { action: 'search', query: 'streaming parser' } },
    { tool: 'agents', args: { action: 'list' } },
  ]);

  workspace.agent.overrideProviderRegistry({
    registry: createProviderRegistry(),
    deps: { env: {}, getAuth: async () => null, hasCredential: async () => false },
    resolveModel: () => model,
    normalizeSpecSync: (spec) => spec ?? 'test/model',
  });

  await workspace.agent.runHostedTaskTurn(child.actor, 'Save what you know, read it back, and list your roster.');

  const results = toolResults(model);
  // A missing dep or an unwired store comes back as `error-json` instead.
  expect(results.map((r) => r.tool)).toEqual(['memory', 'memory', 'agents']);
  expect(results.filter((r) => r.kind === 'error-json')).toEqual([]);
  expect(results[0]?.rendered ?? '').toContain('Note saved to memory.');
  expect(results[1]?.rendered ?? '').toContain('streaming parser');
  // An empty roster is right for a child that has hired nobody; what matters is that the rung answers.
  expect(results[2]?.rendered ?? '').toContain('subordinates');
});

/** Defends: `runHostedTask` falling to the runner's default head prompt instead of the agent prompt that names a hire. */
test('a hired subordinate is framed as a hire, not as a head', async () => {
  const workspace = orchestratorHarness();

  const child = await hostedSubordinateHarness(workspace, {
    name: 'framing-prover', displayName: 'Framing prover', nameOrigin: 'user',
    mission: 'prove the delegated framing',
  });

  const model = turnCalling([]);
  workspace.agent.overrideProviderRegistry({
    registry: createProviderRegistry(),
    deps: { env: {}, getAuth: async () => null, hasCredential: async () => false },
    resolveModel: () => model,
    normalizeSpecSync: (spec) => spec ?? 'test/model',
  });

  await workspace.agent.runHostedTaskTurn(child.actor, 'Say what you are.');

  const system = systemPrompt(model);
  // The head prompt carries neither the hire's name nor the `report` lane.
  expect(system).toContain('Framing prover');
  expect(system).toContain('report');
});

test('a hosted child advertises only its callable crafted surface and loses it when code reach is revoked', async () => {
  const workspace = orchestratorHarness();

  const child = await hostedSubordinateHarness(workspace, {
    name: 'craft-prover', displayName: 'Craft prover', nameOrigin: 'user', mission: 'Inspect your current capabilities.',
  });

  child.actor.runtime.craftStore.create({
    name: 'workspace_echo', description: 'Return the argument', code: '(input) => input', params: null, scope: 'local',
  });
  const model = turnCalling([]);
  workspace.agent.overrideProviderRegistry({
    registry: createProviderRegistry(),
    deps: { env: {}, getAuth: async () => null, hasCredential: async () => false },
    resolveModel: () => model, normalizeSpecSync: (spec) => spec ?? 'test/model',
  });

  await workspace.agent.runHostedTaskTurn(child.actor, 'Inspect your available capabilities.');
  expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain('workspace_echo(...args');
  expect(JSON.stringify(model.doStreamCalls[0]?.tools)).not.toContain('workspace_echo');

  workspace.agent.harnessInstallCatalog({ roles: {
    reader: { description: 'Files only', instructions: 'Inspect files.', tier: 'default', preset: 'ideate', allowedTools: ['file'] },
  } });
  child.actor.stores.config.setRoleSelection('reader');
  await workspace.agent.runHostedTaskTurn(child.actor, 'Inspect the remaining capabilities.');
  const last = model.doStreamCalls.at(-1);
  expect(last?.tools?.map((entry) => entry.name)).not.toContain('eval');
  const current = last?.prompt.filter((message) => message.role === 'user').at(-1);
  expect(JSON.stringify(current)).not.toContain('workspace_echo(...args');
});
