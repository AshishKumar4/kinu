/**
 * Phase D evidence: buildBuiltinTools hands crafted tools to the injected
 * createExecuteTool factory under the shape that produces the `codemode.<name>()`
 * namespace — the LLM-visible contract.
 *
 * We do NOT import the real @cloudflare/codemode here (it's a cf-backend peer
 * dep, not a core dep). Instead we capture the `tools` argument passed to the
 * createExecuteTool factory and assert:
 *
 *   1. The captured `tools` map has an entry keyed by each crafted tool's name.
 *      codemode's createCodeTool turns this into `declare const codemode: {
 *      <name>(input: ...): Promise<...>; }` — see
 *      @cloudflare/codemode/dist/ai.js:113-155 (generateTypes).
 *
 *   2. Each entry's execute is the function produced by our Phase C executor
 *      factory. Calling it fans out to the injected craftedToolExecute.
 *
 *   3. Low-score tools are filtered BEFORE reaching the createExecuteTool
 *      factory — they can't appear in the codemode namespace at all.
 *
 * Phase G's live-server test provides the true end-to-end proof that the LLM
 * actually sees `codemode.double` in the request body. This test exercises the
 * wiring-level invariant: if it's in craftedToolSet, codemode will advertise it.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers.js';
import {
  buildBuiltinTools,
  type CraftedToolExecute,
} from '../src/index.js';

describe('Phase D — crafted tools reach createExecuteTool under codemode.*', () => {
  test('crafted tool appears in the tools map passed to createExecuteTool', () => {
    const { rt } = createTestRuntime();
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0
    )`);
    rt.craftStore.create({
      name: 'double',
      description: 'Doubles its numeric argument',
      params: null,
      code: 'async (n) => n * 2',
      scope: 'local',
    });

    let factoryCallCount = 0;
    const factory: CraftedToolExecute = () => {
      factoryCallCount++;
      return async (arg) => Number(arg) * 2;
    };

    // Capture what the CF adapter would have passed to createExecuteTool.
    let captured: {
      tools: Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
      providers: unknown[];
      loader: unknown;
    } | null = null;
    const captureFactory: Parameters<typeof buildBuiltinTools>[0]['createExecuteTool'] = (opts) => {
      captured = opts;
      return { description: 'mock', execute: async () => null } as never;
    };

    buildBuiltinTools({
      rt,
      codemodeLoader: { get: () => ({ getEntrypoint: () => ({}) }) },
      craftedToolExecute: factory,
      createExecuteTool: captureFactory,
    });

    expect(captured).not.toBeNull();
    const captured2 = captured as NonNullable<typeof captured>;
    const toolNames = Object.keys(captured2.tools);
    expect(toolNames).toContain('double');
    // The loader is forwarded unchanged
    expect(captured2.loader).toBeDefined();

    // Entry shape — description and execute
    const doubleEntry = captured2.tools.double;
    expect(doubleEntry).toBeDefined();
    expect(doubleEntry!.description).toBe('Doubles its numeric argument');
    expect(typeof doubleEntry!.execute).toBe('function');

    // Phase C factory was called exactly once for this tool (per-tool per build)
    expect(factoryCallCount).toBe(1);
  });

  test('invoking the captured execute dispatches into craftedToolExecute', async () => {
    const { rt } = createTestRuntime();
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0
    )`);
    rt.craftStore.create({
      name: 'triple',
      description: 'Triples',
      params: null,
      code: 'async (n) => n * 3',
      scope: 'local',
    });

    let execCalls = 0;
    const factory: CraftedToolExecute = (tool) => async (arg) => {
      execCalls++;
      // Replay the stored code via Node eval; Phase G's live test uses the
      // real child-Worker path — this test just pins the dispatch wiring.
      const fn = new Function('return ' + tool.code)();
      return fn(arg);
    };

    let captured: {
      tools: Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
    } | null = null;
    buildBuiltinTools({
      rt,
      codemodeLoader: { get: () => ({ getEntrypoint: () => ({}) }) },
      craftedToolExecute: factory,
      createExecuteTool: ((opts) => {
        captured = opts as never;
        return { description: '', execute: async () => null };
      }) as never,
    });

    const tripleExec = (captured as never as NonNullable<typeof captured>)!.tools.triple!.execute;
    expect(await tripleExec(7)).toBe(21);
    expect(execCalls).toBe(1);
  });

  test('low-score tool is filtered BEFORE reaching createExecuteTool', () => {
    const { rt } = createTestRuntime();
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0
    )`);
    rt.craftStore.create({
      name: 'forgotten',
      description: 'old tool',
      params: null,
      code: 'async () => null',
      scope: 'local',
    });
    rt.storage.sql`INSERT INTO craft_scores (tool_name, score, last_used_at) VALUES ('forgotten', 0.01, ${Date.now()})`;

    let factoryCalls = 0;
    const factory: CraftedToolExecute = () => {
      factoryCalls++;
      return async () => null;
    };
    let captured: { tools: Record<string, unknown> } | null = null;
    buildBuiltinTools({
      rt,
      codemodeLoader: { get: () => ({ getEntrypoint: () => ({}) }) },
      craftedToolExecute: factory,
      createExecuteTool: ((opts) => {
        captured = opts as never;
        return { description: '', execute: async () => null };
      }) as never,
    });

    expect(factoryCalls).toBe(0);
    const names = Object.keys((captured as never as NonNullable<typeof captured>)!.tools);
    expect(names).not.toContain('forgotten');
  });
});
