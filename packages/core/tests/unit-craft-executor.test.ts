/**
 * Phase B evidence: CLI Node executor round-trips a crafted tool through
 * the canonical code path — stored in CraftStore, filtered by effective
 * score, built into the codemode.* namespace, invoked from sandbox code,
 * returns the right answer.
 *
 * Replays the exact sequence a live chat turn would produce (without an
 * LLM): createTool via workspace, then execute_tools code that calls
 * codemode.<name>(arg). The assertion pins the end-to-end value so a
 * regression in the executor factory breaks this test loudly.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers.js';
import {
  buildBuiltinTools,
  EvolutionEngine,
  type CraftedToolExecute,
} from '../src/index.js';
import { tool, jsonSchema } from 'ai';

// Inline Node craft executor — matches createNodeCraftedExecute from
// @proteus/cli-backend. Kept in this test to avoid an inverted package
// dependency (cli-backend is a downstream workspace).
const createNodeCraftedExecute: () => CraftedToolExecute = () => (t) => {
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

// Minimal Node createExecuteTool factory — sandboxes LLM code with a
// `codemode` binding holding pre-materialised crafted-tool executes.
// Mirrors @proteus/cli-backend/createNodeExecuteToolFactory at the level
// this test needs.
const createNodeExecFactory = () =>
  (opts: {
    tools: Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
  }) => {
    const codemode: Record<string, (arg: unknown) => Promise<unknown>> = {};
    for (const [name, e] of Object.entries(opts.tools)) {
      codemode[name] = e.execute as (arg: unknown) => Promise<unknown>;
    }
    return tool({
      description: 'test exec_tools',
      inputSchema: jsonSchema<{ code: string }>({
        type: 'object', properties: { code: { type: 'string' } }, required: ['code'],
      }),
      execute: async (a: { code: string }) => {
        try {
          const fn = new Function('codemode', 'return (async () => { ' + a.code + ' })()');
          const result = await fn(codemode);
          return { result };
        } catch (e) {
          return { result: undefined, error: (e as Error).message };
        }
      },
    });
  };

describe('Phase B — Node crafted-tool executor', () => {
  test('codemode.<name>(arg) round-trips a stored tool with Node executor', async () => {
    const { rt } = createTestRuntime();
    // craft_scores table needs to exist for the score filter to query it
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0
    )`);

    // Store the tool (simulates a successful workspace.createTool from an earlier turn)
    rt.craftStore.create({
      name: 'double',
      description: 'doubles its arg',
      params: null,
      code: 'async (n) => n * 2',
      scope: 'local',
    });

    const engine = new EvolutionEngine(rt, { enabled: false });
    const tools = buildBuiltinTools({
      rt,
      engine,
      craftedToolExecute: createNodeCraftedExecute(),
      // Phase E: core no longer ships a fallback. The caller supplies the
      // Node execute-tools factory just like cli-backend does in production.
      createExecuteTool: createNodeExecFactory() as never,
    });

    const execTool = tools.execute_tools as {
      execute: (a: { code: string }) => Promise<{ result: unknown; error?: string }>;
    };
    const res = await execTool.execute({
      code: 'return await codemode.double(21);',
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toBe(42);
  });

  test('craftedToolExecute factory is called once per tool per getTools build', async () => {
    const { rt } = createTestRuntime();
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0
    )`);
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

    const engine = new EvolutionEngine(rt, { enabled: false });
    buildBuiltinTools({ rt, engine, craftedToolExecute: factory });
    expect(factoryCalls).toBe(1);
  });

  test('low-scoring tools are filtered out before the factory is invoked', async () => {
    const { rt } = createTestRuntime();
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0
    )`);
    rt.craftStore.create({
      name: 'noisy',
      description: 'noisy',
      params: null,
      code: 'async () => "nope"',
      scope: 'local',
    });
    rt.storage.sql`INSERT INTO craft_scores (tool_name, score, last_used_at) VALUES ('noisy', 0.01, ${Date.now()})`;

    let factoryCalls = 0;
    const factory: CraftedToolExecute = () => {
      factoryCalls++;
      return async () => 'never';
    };
    const engine = new EvolutionEngine(rt, { enabled: false });
    buildBuiltinTools({ rt, engine, craftedToolExecute: factory });
    expect(factoryCalls).toBe(0);
  });
});
