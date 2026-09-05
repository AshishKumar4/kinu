/**
 * Phase D evidence: buildActorTools hands crafted tools to the injected
 * execute_tools builder under the shape that produces the `tools.<name>()`
 * namespace — the LLM-visible contract.
 *
 * We do NOT import the real @cloudflare/codemode here (it's a cf-backend peer
 * dep, not a core dep). Instead we capture the `craftedTools` resolver passed
 * to the builder, call it as the sandbox would, and assert:
 *
 *   1. The resolved map has an entry keyed by each crafted tool's name.
 *      codemode's createCodeTool turns this into `declare const tools: {
 *      <name>(input: ...): Promise<...>; }` — see
 *      @cloudflare/codemode/dist/ai.js:113-155 (generateTypes).
 *
 *   2. Each entry's execute is the function produced by our Phase C executor
 *      factory. Calling it fans out to the injected craftedToolExecute.
 *
 *   3. Low-score tools are filtered BEFORE reaching the builder — they can't
 *      appear in the namespace at all.
 *
 * Phase G's live-server test provides the true end-to-end proof that the LLM
 * actually sees `tools.double` in the request body. This test exercises the
 * wiring-level invariant: if it's in craftedToolSet, codemode will advertise it.
 */

import { describe, test, expect } from 'bun:test';
import { jsonSchema, tool } from 'ai';
import * as v from 'valibot';
import { createTestRuntime } from './helpers';
import {
  buildActorTools,
  type ActorToolsetDeps,
  type CraftedToolExecute,
  type ExecuteToolsBuilder,
  type ExecuteToolsSurface,
} from '../src/index';

interface CapturedExecuteTool {
  builder: ExecuteToolsBuilder;
  surface: () => ExecuteToolsSurface;
}

/**
 * Capture the surface a backend's builder is handed.
 *
 * A box rather than a `let`: TypeScript cannot see an assignment made inside a
 * callback, so a `let x: T | null = null` reads back as `null` and every use
 * needs a cast to undo the narrowing.
 */
function captureExecuteTool(): CapturedExecuteTool {
  const seen: ExecuteToolsSurface[] = [];
  return {
    builder: (surface) => {
      seen.push(surface);
      return tool({
        description: 'mock',
        inputSchema: jsonSchema({ type: 'object' }),
        execute: async () => null,
      });
    },
    surface: () => {
      const first = seen[0];
      if (!first) throw new Error('the execute_tools builder was never called');
      return first;
    },
  };
}

function actorTools(rt: ActorToolsetDeps['rt'], deps: Pick<ActorToolsetDeps, 'craftedToolExecute' | 'executeTools'>) {
  return buildActorTools({ rt, effectClaims: { sql: rt.storage.sql, turnId: () => 'turn-1' }, ...deps });
}

describe('Phase D — crafted tools reach the execute_tools builder under tools.*', () => {
  test('crafted tool appears in the tools map passed to the builder', () => {
    const { rt } = createTestRuntime();
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
    actorTools(rt, { craftedToolExecute: factory, executeTools: capture.builder });

    const captured = capture.surface();
    // Nothing is resolved until the sandbox asks: the crafted set is read per
    // execute so a tool crafted mid-turn is callable on the next call.
    expect(factoryCallCount).toBe(0);

    const resolved = captured.craftedTools();
    expect(Object.keys(resolved)).toContain('double');
    // The builder sees the finished native surface it declares as `tools.*`.
    expect(Object.keys(captured.native)).toEqual(expect.arrayContaining(['run', 'file', 'memory', 'tasks']));

    // Entry shape — description and execute
    const doubleEntry = resolved.double;
    expect(doubleEntry).toBeDefined();
    expect(doubleEntry!.description).toBe('Doubles its numeric argument');
    expect(doubleEntry!.execute).toBeFunction();

    // Phase C factory was called exactly once for this tool, per resolution.
    expect(factoryCallCount).toBe(1);
  });

  test('a tool crafted after the toolset was built is callable on the next resolve', async () => {
    const { rt } = createTestRuntime();
    const capture = captureExecuteTool();
    actorTools(rt, {
      craftedToolExecute: (source) => async (arg) => {
        if (source.name !== 'quadruple') throw new Error(`unexpected tool ${source.name}`);
        return v.parse(v.number(), arg) * 4;
      },
      executeTools: capture.builder,
    });
    const resolve = capture.surface().craftedTools;
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
      if (tool.name !== 'triple') throw new Error(`unexpected tool ${tool.name}`);
      return v.parse(v.number(), arg) * 3;
    };

    const capture = captureExecuteTool();
    actorTools(rt, { craftedToolExecute: factory, executeTools: capture.builder });

    const tripleExec = capture.surface().craftedTools().triple!.execute;
    expect(await tripleExec(7)).toBe(21);
    expect(execCalls).toBe(1);
  });

  test('low-score tool is filtered BEFORE reaching the builder', () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'forgotten',
      description: 'old tool',
      params: null,
      code: 'async () => null',
      scope: 'local',
    });
    void rt.storage.sql`UPDATE crafted_tools SET score = 0.01, last_used_at = ${Date.now()} WHERE name = 'forgotten'`;

    let factoryCalls = 0;
    const factory: CraftedToolExecute = () => {
      factoryCalls++;
      return async () => null;
    };
    const capture = captureExecuteTool();
    actorTools(rt, { craftedToolExecute: factory, executeTools: capture.builder });

    const names = Object.keys(capture.surface().craftedTools());
    expect(factoryCalls).toBe(0);
    expect(names).not.toContain('forgotten');
  });
});
