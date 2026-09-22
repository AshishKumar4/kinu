/** A stored tool is filtered by effective score, materialised into the codemode map and invoked through
 *  the codemode-tool factory; the platform compiler is tested in each backend. */

import { describe, test, expect } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import { createTestRuntime, storesFor } from './helpers';
import {
  buildActorTools,
  craftFailureMarker,
  selectInjectableCraftedTools,
  type ActorToolsetDeps,
  type CraftedToolSet,
  type CodemodeBuilder,
  type CraftedToolExecute,
  type CraftedToolSource,
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

// Minimal Node eval builder mirroring cli-backend's createNodeCodemodeToolFactory as far as this test needs.
interface CraftedToolsCapture {
  builder: CodemodeBuilder;
  taken: () => (() => CraftedToolSet) | undefined;
}

/** A codemode builder that keeps the surface's crafted-tool resolver for the test. */
function captureCraftedTools(): CraftedToolsCapture {
  let resolve: (() => CraftedToolSet) | undefined;

  return {
    builder: (surface) => {
      resolve = surface.craftedTools;

      return tool({
        description: 'capture crafted tools',
        inputSchema: jsonSchema({ type: 'object' }),
        execute: async () => null,
      });
    },
    taken: () => resolve,
  };
}

function createTestCodemodeBuilder(
  invoke: (tools: CraftedToolSet) => Promise<JsonValue | undefined>,
): CodemodeBuilder {
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

/** An actor surface over `rt` whose sandbox is `codemode`. */
function actorTools(rt: ActorToolsetDeps['rt'], deps: Pick<ActorToolsetDeps, 'craftedToolExecute' | 'codemode'>) {
  return buildActorTools({ rt, effectClaims: { sql: rt.storage.sql, actor: rt.actor, turnId: () => 'turn-1' }, ...deps, history: storesFor(rt).history });
}

function requiredCraftedTool(tools: CraftedToolSet, name: string) {
  const entry = tools[name];

  if (!entry) throw new Error(`missing crafted tool ${name}`);

  return entry;
}

describe('crafted-tool execution integration', () => {
  test('host and sandbox compilers receive the same eligible names, normalized source and descriptions', async () => {
    const { rt } = createTestRuntime();

    for (const [name, code] of [
      ['healthy', '  async () => 1  '], ['shell', 'async () => 2'],
      ['mcp_shadow', 'async () => 3'], ['empty', '   '], ['comment', '  // disabled'],
      ['retired', 'async () => 4'],
    ] as const) {
      rt.craftStore.create({ name, code, description: '', params: null, scope: 'local' });
    }

    void rt.storage.sql`UPDATE crafted_tools SET score = 0.01, last_used_at = ${Date.now()} WHERE name = 'retired'`;
    const compiled: CraftedToolSource[] = [];

    const tools = actorTools(rt, {
      craftedToolExecute: (source) => {
        compiled.push(source);

        return async () => null;
      },
      codemode: createTestCodemodeBuilder(async (crafted) => Object.keys(crafted).join(',')),
    });

    const execute = toolExecute<{ code: string }, JsonValue>(tools.eval);
    const result = v.parse(ExecuteResultSchema, await execute({ code: 'list crafted tools' }));
    expect(result.result).toBe('healthy');
    expect(compiled).toEqual(selectInjectableCraftedTools(rt.craftStore, rt.storage.sql));
    expect(compiled).toEqual([{ name: 'healthy', code: 'async () => 1', description: 'Crafted tool: healthy' }]);
  });

  test('both compilation paths report an unreadable store instead of silently removing all crafted tools', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.list = () => { throw new Error('crafted store unavailable'); };

    const tools = actorTools(rt, {
      craftedToolExecute: createTestCraftedExecute(),
      codemode: createTestCodemodeBuilder(async (crafted) => Object.keys(crafted).join(',')),
    });

    expect(() => selectInjectableCraftedTools(rt.craftStore, rt.storage.sql)).toThrow('crafted store unavailable');
    const execute = toolExecute<{ code: string }, JsonValue>(tools.eval);
    const result = v.parse(ExecuteResultSchema, await execute({ code: 'list unavailable crafted tools' }));
    expect(result.error).toBe('crafted store unavailable');
    expect(result.result).toBeUndefined();
  });

  test('tools.<name>(arg) round-trips a stored tool', async () => {
    const { rt } = createTestRuntime();

    // Store the tool, as an earlier turn's workspace.createTool would.
    rt.craftStore.create({
      name: 'double',
      description: 'doubles its arg',
      params: null,
      code: 'async (n) => n * 2',
      scope: 'local',
    });

    const tools = actorTools(rt, {
      craftedToolExecute: createTestCraftedExecute(),
      codemode: createTestCodemodeBuilder(async (crafted) =>
        requiredCraftedTool(crafted, 'double').execute(21)),
    });

    const execTool = toolExecute<{ code: string }, JsonValue>(tools.eval);

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
      codemode: createTestCodemodeBuilder(async (crafted) =>
        requiredCraftedTool(crafted, 'exploder').execute(null)),
    });

    const execTool = toolExecute<{ code: string }, JsonValue>(tools.eval);

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
      codemode: createTestCodemodeBuilder(async (crafted) =>
        requiredCraftedTool(crafted, 'quiet').execute(null)),
    });

    const res = v.parse(ExecuteResultSchema, await toolExecute<{ code: string }, JsonValue>(tools.eval)(
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

    const factory: CraftedToolExecute = (crafted) => {
      factoryCalls++;

      return async (arg) => `${crafted.name}:${JSON.stringify(arg)}`;
    };

    const capture = captureCraftedTools();

    actorTools(rt, { craftedToolExecute: factory, codemode: capture.builder });
    // Building resolves nothing: the sandbox asks per execute, so a tool crafted mid-turn is callable next call.
    expect(factoryCalls).toBe(0);

    const resolve = capture.taken();

    if (!resolve) throw new Error('codemode-tool factory was not built');
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

    const capture = captureCraftedTools();

    actorTools(rt, { craftedToolExecute: factory, codemode: capture.builder });

    const resolve = capture.taken();

    if (!resolve) throw new Error('codemode-tool builder was not called');
    expect(Object.keys(resolve())).toEqual([]);
    expect(factoryCalls).toBe(0);
  });
});
