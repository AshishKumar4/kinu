/**
 * Crafted-tool integration evidence: a stored tool is filtered by effective
 * score, materialised into the codemode map, and invoked through the platform
 * execute-tools factory.
 *
 * The platform compiler itself belongs to each backend's suite. This test
 * keeps core independent of those downstream packages and pins the shared
 * storage-to-tool-map contract.
 */

import { describe, test, expect } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import { createTestRuntime } from './helpers';
import {
  buildActorTools,
  craftFailureMarker,
  type ActorToolsetDeps,
  type CraftedToolSet,
  type ExecuteToolsBuilder,
  type CraftedToolExecute,
  type JsonValue,
} from '../src/index';
import { tool, jsonSchema } from 'ai';
import * as v from 'valibot';

const ExecuteResultSchema = v.object({
  result: v.optional(v.union([v.string(), v.number(), v.boolean(), v.null()])),
  error: v.optional(v.string()),
});

const createTestCraftedExecute = (): CraftedToolExecute => (source) => async (arg) => {
  if (source.name === 'double') return v.parse(v.number(), arg) * 2;
  if (source.name === 'exploder') throw new Error('inner boom');
  if (source.name === 'quiet') return 'ok';
  throw new Error(`unexpected crafted tool ${source.name}`);
};

// Minimal Node execute_tools builder — sandboxes LLM code with a `codemode`
// binding holding pre-materialised crafted-tool executes. Mirrors
// @kinu.run/cli-backend/createNodeExecuteToolFactory at the level this test
// needs.
function createTestExecBuilder(
  invoke: (tools: CraftedToolSet) => Promise<JsonValue | undefined>,
): ExecuteToolsBuilder {
  return (surface) => {
    return tool({
      description: 'test exec_tools',
      inputSchema: jsonSchema<{ code: string }>({
        type: 'object', properties: { code: { type: 'string' } }, required: ['code'],
      }),
      execute: async () => {
        try {
          return { result: await invoke(surface.craftedTools()) };
        } catch (error) {
          return { result: undefined, error: error instanceof Error ? error.message : String(error) };
        }
      },
    });
  };
}

/** An actor surface over `rt` whose sandbox is `executeTools`. */
function actorTools(rt: ActorToolsetDeps['rt'], deps: Pick<ActorToolsetDeps, 'craftedToolExecute' | 'executeTools'>) {
  return buildActorTools({ rt, effectClaims: { sql: rt.storage.sql, turnId: () => 'turn-1' }, ...deps });
}

function requiredCraftedTool(tools: CraftedToolSet, name: string) {
  const entry = tools[name];
  if (!entry) throw new Error(`missing crafted tool ${name}`);
  return entry;
}

describe('crafted-tool execution integration', () => {
  test('tools.<name>(arg) round-trips a stored tool', async () => {
    const { rt } = createTestRuntime();

    // Store the tool (simulates a successful workspace.createTool from an earlier turn)
    rt.craftStore.create({
      name: 'double',
      description: 'doubles its arg',
      params: null,
      code: 'async (n) => n * 2',
      scope: 'local',
    });

    const tools = actorTools(rt, {
      craftedToolExecute: createTestCraftedExecute(),
      executeTools: createTestExecBuilder(async (crafted) =>
        requiredCraftedTool(crafted, 'double').execute(21)),
    });

    const execTool = toolExecute<{ code: string }, JsonValue>(tools.execute_tools);
    const res = v.parse(ExecuteResultSchema, await execTool({
      code: 'return await tools.double(21);',
    }));
    expect(res.error).toBeUndefined();
    expect(res.result).toBe(42);
  });

  test('a crafted tool that raises leaves the sandbox stamped with its identity', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'exploder',
      description: 'always throws',
      params: null,
      code: 'async () => { throw new Error("inner boom"); }',
      scope: 'local',
    });

    const tools = actorTools(rt, {
      craftedToolExecute: createTestCraftedExecute(),
      executeTools: createTestExecBuilder(async (crafted) =>
        requiredCraftedTool(crafted, 'exploder').execute(null)),
    });
    const execTool = toolExecute<{ code: string }, JsonValue>(tools.execute_tools);

    const res = v.parse(ExecuteResultSchema, await execTool({ code: 'return await tools.exploder();' }));
    // The model is told WHICH of its own tools broke, and the in-episode
    // fitness signal reads the same stamp to score that artifact and no other.
    expect(res.error).toContain(craftFailureMarker('exploder'));
    expect(res.error).toContain('inner boom');
  });

  test('a tool that RETURNS normally is not stamped', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'quiet', description: 'fine', params: null,
      code: 'async () => "ok"', scope: 'local',
    });
    const tools = actorTools(rt, {
      craftedToolExecute: createTestCraftedExecute(),
      executeTools: createTestExecBuilder(async (crafted) =>
        requiredCraftedTool(crafted, 'quiet').execute(null)),
    });
    const res = v.parse(ExecuteResultSchema, await toolExecute<{ code: string }, JsonValue>(tools.execute_tools)(
      { code: 'return await tools.quiet();' },
    ));
    expect(res.error).toBeUndefined();
    expect(res.result).toBe('ok');
  });

  test('a body is compiled once, and again only when the tool is rewritten', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'identity',
      description: 'returns arg',
      params: null,
      code: 'async (x) => x',
      scope: 'local',
    });

    let factoryCalls = 0;
    const factory: CraftedToolExecute = (tool) => {
      factoryCalls++;
      return async (arg) => `${tool.name}:${JSON.stringify(arg)}`;
    };

    let resolve: (() => CraftedToolSet) | undefined;
    const captureBuilder: ExecuteToolsBuilder = (surface) => {
      resolve = surface.craftedTools;
      return tool({
        description: 'capture crafted tools',
        inputSchema: jsonSchema({ type: 'object' }),
        execute: async () => null,
      });
    };
    actorTools(rt, { craftedToolExecute: factory, executeTools: captureBuilder });
    // Building resolves nothing — the sandbox asks per execute, which is what
    // makes a tool crafted mid-turn callable on the next call.
    expect(factoryCalls).toBe(0);
    if (!resolve) throw new Error('execute-tools factory was not built');
    resolve();
    resolve();
    // …and asking repeatedly costs one compile, not one per call.
    expect(factoryCalls).toBe(1);

    // A tool the agent REWRITES mid-turn must not keep running its old body.
    rt.craftStore.update('identity', { code: 'async (x) => x + 1' });
    resolve();
    expect(factoryCalls).toBe(2);
  });

  test('low-scoring tools are filtered out before the factory is invoked', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'noisy',
      description: 'noisy',
      params: null,
      code: 'async () => "nope"',
      scope: 'local',
    });
    void rt.storage.sql`UPDATE crafted_tools SET score = 0.01, last_used_at = ${Date.now()} WHERE name = 'noisy'`;

    let factoryCalls = 0;
    const factory: CraftedToolExecute = () => {
      factoryCalls++;
      return async () => 'never';
    };
    let resolve: (() => CraftedToolSet) | undefined;
    actorTools(rt, {
      craftedToolExecute: factory,
      executeTools: (surface) => {
        resolve = surface.craftedTools;
        return tool({
          description: 'capture crafted tools',
          inputSchema: jsonSchema({ type: 'object' }),
          execute: async () => null,
        });
      },
    });
    if (!resolve) throw new Error('execute-tools builder was not called');
    expect(Object.keys(resolve())).toEqual([]);
    expect(factoryCalls).toBe(0);
  });
});
