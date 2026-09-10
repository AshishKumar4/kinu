/**
 * A HIRED SUBORDINATE HAS THE FULL-AGENT SURFACE, AND IT WORKS.
 *
 * docs/TOOLS.md and AGENTS.md promise a hire the eight builtins through the
 * same `buildActorTools` path the workspace root's own turns are built by,
 * gated by the deps this workspace wires for it. The delegated turn used to be
 * built from the confined HEAD set instead — four tools, no `agents`, no
 * `memory`, no `tasks`, and not even the `report` lane the conformance manifest
 * declares for this exact root — so a colleague hired to work in the workspace
 * could neither remember anything, keep a task list, nor delegate under its own
 * depth.
 *
 * Conformance (tests/conformance.test.ts) pins the SHAPE: which tools and which
 * action enums a delegated turn is handed. This pins that two of them RUN, on
 * the child's own stores, driven the only way a subordinate's tools are ever
 * driven — its assigned turn through the production runner. The two chosen are
 * the two the shape check cannot vouch for: `memory` writes and reads back
 * through the workspace store, and `agents` needs a roster rung built from the
 * child's OWN directory row rather than the root's.
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

/** One scripted tool call. */
interface ScriptedCall {
  readonly tool: string;
  readonly args: JsonObject;
}

/** The step this request is: how many tool results the conversation already
 *  carries. Read off the prompt rather than counted in a closure, so a retried
 *  request answers the same way the first one did. */
const step = (options: ScriptedTurnOptions): number =>
  options.prompt.filter((message) => message.role === 'tool').length;

/** A turn that makes each call in order, one per step, then answers. */
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

/** What each tool call ANSWERED, in call order — read off the requests the
 *  turn went on to make, which is where a tool's output reaches the model.
 *
 *  The output is kept as its DISCRIMINANT plus its rendered text: `json` and
 *  `error-json` are the two the SDK distinguishes, and a refusal from a
 *  missing dep arrives as the second. */
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

/** The system prompt the turn was actually issued under, off the request the
 *  provider received. */
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
  // Each call ANSWERED, and answered with its own success: a missing dep or an
  // unwired store comes back as `error-json` instead.
  expect(results.map((r) => r.tool)).toEqual(['memory', 'memory', 'agents']);
  expect(results.filter((r) => r.kind === 'error-json')).toEqual([]);
  expect(results[0]?.rendered ?? '').toContain('Note saved to memory.');
  // The note it saved, read back out of the workspace memory store by its own
  // `memory` tool: the write landed and the search found it.
  expect(results[1]?.rendered ?? '').toContain('streaming parser');
  // Its own roster, from its own directory row. An empty roster is the right
  // answer for a child that has hired nobody; what matters is that the rung
  // exists and answers, which is what the head surface had no tool for.
  expect(results[2]?.rendered ?? '').toContain('subordinates');
});

/**
 * AND IT IS FRAMED AS ONE.
 *
 * `runHostedTask` passed no framing, so the shared runner fell to its own
 * default — the HEAD prompt — and a colleague hired into a workspace was told
 * it was one of several parallel reasoning threads competing over one tree,
 * with conventions for tools it does not hold and a merge nobody was running.
 * The framing a parent-assigned turn runs under is the product's own agent
 * prompt, and the `report` lane on its surface is what makes that prompt name
 * it as a hire (core's `state/delegation` section).
 */
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
  // Named as what it is: a hired agent of this workspace whose `report` lane
  // carries progress back to whoever assigned the work.
  expect(system).toContain('You are a subordinate agent of this workspace');
  expect(system).toContain('report');
  // And never as a head. Both sentences are the fork framing's, and neither is
  // true of a hire: nothing merges its findings and it has no siblings racing
  // it for the tree.
  expect(system).not.toContain('You are a "head"');
  expect(system).not.toContain('ONE OF SEVERAL heads');
});
