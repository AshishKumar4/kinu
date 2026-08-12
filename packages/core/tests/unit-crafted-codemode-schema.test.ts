/**
 * Phase D evidence: buildBuiltinTools hands crafted tools to the injected
 * createExecuteTool factory under the shape that produces the `codemode.<name>()`
 * namespace — the LLM-visible contract.
 *
 * We do NOT import the real @cloudflare/codemode here (it's a cf-backend peer
 * dep, not a core dep). Instead we capture the `craftedTools` resolver passed
 * to the createExecuteTool factory, call it as the sandbox would, and assert:
 *
 *   1. The resolved map has an entry keyed by each crafted tool's name.
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
  type CreateExecuteToolFactory,
} from '../src/index.js';

type ExecuteToolOptions = Parameters<CreateExecuteToolFactory>[0];

/**
 * Capture what the CF adapter would have passed to createExecuteTool.
 *
 * A box rather than a `let`: TypeScript cannot see an assignment made inside a
 * callback, so a `let x: T | null = null` reads back as `null` and every use
 * needs a cast to undo the narrowing.
 */
function captureExecuteTool(): {
  factory: CreateExecuteToolFactory;
  options: () => ExecuteToolOptions;
} {
  const seen: ExecuteToolOptions[] = [];
  return {
    factory: (opts) => {
      seen.push(opts);
      return { description: 'mock', execute: async () => null };
    },
    options: () => {
      const first = seen[0];
      if (!first) throw new Error('createExecuteTool was never called');
      return first;
    },
  };
}

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

    const capture = captureExecuteTool();
    buildBuiltinTools({
      rt,
      codemodeLoader: { get: () => ({ getEntrypoint: () => ({}) }) },
      craftedToolExecute: factory,
      createExecuteTool: capture.factory,
    });

    const captured = capture.options();
    // Nothing is resolved until the sandbox asks: the crafted set is read per
    // execute so a tool crafted mid-turn is callable on the next call.
    expect(factoryCallCount).toBe(0);

    const resolved = captured.craftedTools();
    expect(Object.keys(resolved)).toContain('double');
    // The loader is forwarded unchanged
    expect(captured.loader).toBeDefined();

    // Entry shape — description and execute
    const doubleEntry = resolved.double;
    expect(doubleEntry).toBeDefined();
    expect(doubleEntry!.description).toBe('Doubles its numeric argument');
    expect(typeof doubleEntry!.execute).toBe('function');

    // Phase C factory was called exactly once for this tool, per resolution.
    expect(factoryCallCount).toBe(1);
  });

  test('a tool crafted after the toolset was built is callable on the next resolve', async () => {
    const { rt } = createTestRuntime();
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0
    )`);
    const capture = captureExecuteTool();
    buildBuiltinTools({
      rt,
      codemodeLoader: { get: () => ({ getEntrypoint: () => ({}) }) },
      craftedToolExecute: (tool) => async (arg) => (new Function('return ' + tool.code)() as (a: unknown) => unknown)(arg),
      createExecuteTool: capture.factory,
    });
    const resolve = capture.options().craftedTools;
    expect(Object.keys(resolve())).toEqual([]);

    // The in-episode move: the agent crafts a tool mid-turn.
    rt.craftStore.create({
      name: 'quadruple', description: 'x4', params: null,
      code: 'async (n) => n * 4', scope: 'local',
    });

    const after = resolve();
    expect(Object.keys(after)).toContain('quadruple');
    expect(await after.quadruple!.execute(5)).toBe(20);
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

    const capture = captureExecuteTool();
    buildBuiltinTools({
      rt,
      codemodeLoader: { get: () => ({ getEntrypoint: () => ({}) }) },
      craftedToolExecute: factory,
      createExecuteTool: capture.factory,
    });

    const tripleExec = capture.options().craftedTools().triple!.execute;
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
    const capture = captureExecuteTool();
    buildBuiltinTools({
      rt,
      codemodeLoader: { get: () => ({ getEntrypoint: () => ({}) }) },
      craftedToolExecute: factory,
      createExecuteTool: capture.factory,
    });

    const names = Object.keys(capture.options().craftedTools());
    expect(factoryCalls).toBe(0);
    expect(names).not.toContain('forgotten');
  });
});
