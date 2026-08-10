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
  craftFailureMarker,
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
    craftedTools: () => Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
  }) => {
    return tool({
      description: 'test exec_tools',
      inputSchema: jsonSchema<{ code: string }>({
        type: 'object', properties: { code: { type: 'string' } }, required: ['code'],
      }),
      execute: async (a: { code: string }) => {
        try {
          const codemode: Record<string, (arg: unknown) => Promise<unknown>> = {};
          for (const [name, e] of Object.entries(opts.craftedTools())) {
            codemode[name] = e.execute as (arg: unknown) => Promise<unknown>;
          }
          const fn = new Function('codemode', 'tools', 'return (async () => { ' + a.code + ' })()');
          const result = await fn(codemode, codemode);
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

    const tools = buildBuiltinTools({
      rt,
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

  test('a crafted tool that raises leaves the sandbox stamped with its identity', async () => {
    const { rt } = createTestRuntime();
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0
    )`);
    rt.craftStore.create({
      name: 'exploder',
      description: 'always throws',
      params: null,
      code: 'async () => { throw new Error("inner boom"); }',
      scope: 'local',
    });

    const tools = buildBuiltinTools({
      rt,
      craftedToolExecute: createNodeCraftedExecute(),
      createExecuteTool: createNodeExecFactory() as never,
    });
    const execTool = tools.execute_tools as {
      execute: (a: { code: string }) => Promise<{ result: unknown; error?: string }>;
    };

    const res = await execTool.execute({ code: 'return await codemode.exploder();' });
    // The model is told WHICH of its own tools broke, and the in-episode
    // fitness signal reads the same stamp to score that artifact and no other.
    expect(res.error).toContain(craftFailureMarker('exploder'));
    expect(res.error).toContain('inner boom');
  });

  test('a tool that RETURNS normally is not stamped', async () => {
    const { rt } = createTestRuntime();
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0
    )`);
    rt.craftStore.create({
      name: 'quiet', description: 'fine', params: null,
      code: 'async () => "ok"', scope: 'local',
    });
    const tools = buildBuiltinTools({
      rt,
      craftedToolExecute: createNodeCraftedExecute(),
      createExecuteTool: createNodeExecFactory() as never,
    });
    const res = await (tools.execute_tools as {
      execute: (a: { code: string }) => Promise<{ result: unknown; error?: string }>;
    }).execute({ code: 'return await codemode.quiet();' });
    expect(res.error).toBeUndefined();
    expect(res.result).toBe('ok');
  });

  test('a body is compiled once, and again only when the tool is rewritten', async () => {
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

    let resolve: (() => Record<string, unknown>) | null = null;
    buildBuiltinTools({
      rt,
      craftedToolExecute: factory,
      codemodeLoader: { __test: true },
      createExecuteTool: ((opts: { craftedTools: () => Record<string, unknown> }) => {
        resolve = opts.craftedTools;
        return { description: '', execute: async () => null };
      }) as never,
    });
    // Building resolves nothing — the sandbox asks per execute, which is what
    // makes a tool crafted mid-turn callable on the next call.
    expect(factoryCalls).toBe(0);
    resolve!();
    resolve!();
    // …and asking repeatedly costs one compile, not one per call.
    expect(factoryCalls).toBe(1);

    // A tool the agent REWRITES mid-turn must not keep running its old body.
    rt.craftStore.update('identity', { code: 'async (x) => x + 1' });
    resolve!();
    expect(factoryCalls).toBe(2);
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
    buildBuiltinTools({ rt, craftedToolExecute: factory });
    expect(factoryCalls).toBe(0);
  });
});
