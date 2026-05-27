/**
 * Unit tests for the canonical 6-tool surface (v2.1 — added split_heads).
 *
 * v2.0 surface (CLI / always): execute_tools, run, explore, save_note, search_memory.
 * v2.1 addition (CF only when splitHeadsTool is supplied): split_heads.
 *
 * The split_heads tool is conditional because it requires a HeadController +
 * HeadRuntime — CF supplies them via createSplitHeadsTool; CLI doesn't have
 * Facets and omits the tool. BUILTIN_TOOLS lists all 6 canonical names so
 * crafted-tool filtering (BUILT_IN_TOOL_NAMES) excludes split_heads from
 * craft suggestions.
 */

import { describe, test, expect } from 'bun:test';
import { tool, jsonSchema } from 'ai';
import { createTestRuntime } from './helpers.js';
import {
  buildBuiltinTools,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_DESCRIPTIONS,
  EvolutionEngine,
  type CraftedToolExecute,
} from '../src/index.js';

// v2.1(E): core has no in-process fallback. Tests wire the same Node
// executor factory that cli-backend ships in production.
const nodeCraftedExecute: CraftedToolExecute = (t) => {
  let compiled: ((arg: unknown) => Promise<unknown>) | null = null;
  return async (arg) => {
    if (!compiled) {
      const fn = new Function('return (' + t.code + ')')();
      if (typeof fn !== 'function') throw new Error(`${t.name} not a function`);
      compiled = fn as (arg: unknown) => Promise<unknown>;
    }
    return compiled(arg);
  };
};

const nodeExecFactory = (opts: {
  tools: Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
}) => {
  const codemode: Record<string, (arg: unknown) => Promise<unknown>> = {};
  for (const [n, e] of Object.entries(opts.tools)) {
    codemode[n] = e.execute as (arg: unknown) => Promise<unknown>;
  }
  return tool({
    description: 'test exec_tools',
    inputSchema: jsonSchema<{ code: string }>({
      type: 'object', properties: { code: { type: 'string' } }, required: ['code'],
    }),
    execute: async (a: { code: string }) => {
      try {
        const fn = new Function('workspace', 'codemode', 'return (async () => { ' + a.code + ' })()');
        const result = await fn({}, codemode);
        return { result };
      } catch (e) {
        return { result: undefined, error: (e as Error).message };
      }
    },
  });
};

function tools(rt: ReturnType<typeof createTestRuntime>['rt']) {
  const engine = new EvolutionEngine(rt, { enabled: false });
  return buildBuiltinTools({
    rt, engine,
    craftedToolExecute: nodeCraftedExecute,
    createExecuteTool: nodeExecFactory as never,
    codemodeLoader: { __test: true } as unknown,
  });
}

describe('Agent tools (v2.1 canonical 6-tool surface — split_heads conditional)', () => {
  test('without splitHeadsTool: 5 base tools, split_heads omitted', () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const names = Object.keys(t);
    const expected = BUILTIN_TOOLS.filter((n) => n !== 'split_heads');

    for (const canonical of expected) {
      expect(names).toContain(canonical);
    }
    expect(names).not.toContain('split_heads');
    expect(names.length).toBe(5);
    expect(names.sort()).toEqual([...expected].sort());
  });

  test('with splitHeadsTool stub: all 6 canonical tools present', () => {
    const { rt } = createTestRuntime();
    const engine = new EvolutionEngine(rt, { enabled: false });
    const stubSplitHeads = tool({
      description: 'stub split_heads',
      inputSchema: jsonSchema<{ rationale: string }>({
        type: 'object', properties: { rationale: { type: 'string' } }, required: ['rationale'],
      }),
      execute: async () => 'stub',
    });
    const t = buildBuiltinTools({
      rt, engine,
      craftedToolExecute: nodeCraftedExecute,
      createExecuteTool: nodeExecFactory as never,
      codemodeLoader: { __test: true } as unknown,
      splitHeadsTool: stubSplitHeads,
    });
    const names = Object.keys(t);
    for (const canonical of BUILTIN_TOOLS) expect(names).toContain(canonical);
    expect(names.length).toBe(6);
    expect(names.sort()).toEqual([...BUILTIN_TOOLS].sort());
  });

  test('each tool carries description + inputSchema', () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);
    for (const [, v] of Object.entries(t)) {
      const tool = v as { description?: string; inputSchema?: unknown };
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
    }
  });

  test('descriptions document both codemode.* and tools.<name> namespaces', () => {
    // Preamble-pattern invariant: both namespaces are real.
    //   codemode.* dispatches over RPC into host-side provider fns.
    //   tools.<name> resolves locally inside the preamble-injected object
    //     literal (crafted tools, via PreambleCraftedExecutor).
    // Either can invoke a crafted tool; the prompt must advertise both.
    expect(BUILTIN_TOOL_DESCRIPTIONS.execute_tools).toContain('codemode.*');
    expect(BUILTIN_TOOL_DESCRIPTIONS.execute_tools).toContain('tools.');
  });

  test('save_note appends to MEMORY.md', async () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const tool = t.save_note as { execute: (args: { content: string }) => Promise<string> };

    const result = await tool.execute({ content: 'Remember: Python prefers snake_case' });
    expect(result).toContain('saved');

    const memory = await rt.memory.read('memory/MEMORY.md');
    expect(memory).toContain('snake_case');
  });

  test('search_memory returns a string', async () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);

    await rt.memory.write('memory/test.md', 'This is about machine learning');
    await rt.memory.index('memory/test.md');

    const tool = t.search_memory as { execute: (args: { query: string }) => Promise<string> };
    const result = await tool.execute({ query: 'machine learning' });
    expect(typeof result).toBe('string');
  });

  test('run in workspace mode falls back gracefully when no shell provided', async () => {
    // Test runtime has no rt.shell — `run` must return an error string rather
    // than throwing. This lets test harnesses exercise the tool shape without
    // providing a real shell dependency.
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const tool = t.run as { execute: (args: { command: string }) => Promise<string> };
    const result = await tool.execute({ command: 'echo hi' });
    expect(typeof result).toBe('string');
    expect(result).toContain('Error');
  });

  test('execute_tools exposes workspace and codemode globals', async () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const tool = t.execute_tools as { execute: (args: { code: string }) => Promise<{ result: unknown }> };
    const result = await tool.execute({
      code: "return typeof workspace + ',' + typeof codemode;",
    });
    expect(result.result).toBe('object,object');
  });

  test('crafted tools become bare callables under codemode.<name>', async () => {
    const { rt } = createTestRuntime();
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0
    )`);
    rt.craftStore.create({
      name: 'double', description: 'doubles a number', params: null,
      code: 'async (x) => x * 2', scope: 'local',
    });

    const t = tools(rt);
    const tool = t.execute_tools as { execute: (a: { code: string }) => Promise<{ result: unknown }> };
    const result = await tool.execute({ code: 'return await codemode.double(21);' });
    expect(result.result).toBe(42);
  });

  test('low-scoring crafted tools filtered out of codemode namespace', async () => {
    const { rt } = createTestRuntime();
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0
    )`);
    rt.craftStore.create({
      name: 'weak', description: 'low quality', params: null,
      code: 'async () => "should never run"', scope: 'local',
    });
    rt.storage.sql`INSERT INTO craft_scores (tool_name, score, last_used_at) VALUES ('weak', 0.01, ${Date.now()})`;

    const t = tools(rt);
    const tool = t.execute_tools as { execute: (a: { code: string }) => Promise<{ result: unknown }> };
    const result = await tool.execute({ code: 'return typeof codemode.weak;' });
    expect(result.result).toBe('undefined');
  });

  // v2.1(E): same-turn codemode.<name> for a NEW tool is no longer supported.
  // The Proxy live-lookup path used host-side new Function and was removed.
  // Tools created this turn become available next turn (getTools rebuilds).
});
