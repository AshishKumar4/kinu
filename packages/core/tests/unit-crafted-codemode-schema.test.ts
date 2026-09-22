/**
 * buildActorTools hands crafted tools to the injected eval builder in the shape codemode turns into
 * `tools.<name>()`. The real @cloudflare/codemode is a cf-backend dep, so the resolver is called here as the
 * sandbox would.
 */

import { describe, test, expect } from 'bun:test';
import { jsonSchema, tool } from 'ai';
import * as v from 'valibot';
import { createTestRuntime, storesFor } from './helpers';
import {
  buildActorTools,
  type ActorToolsetDeps,
  type CraftedToolExecute,
  type CodemodeBuilder,
  type CodemodeSurface,
} from '../src/index';

interface CapturedExecuteTool {
  builder: CodemodeBuilder;
  surface: () => CodemodeSurface;
}

/** Capture the builder's surface. A box, not a `let`: TypeScript cannot see an assignment inside a callback. */
function captureExecuteTool(): CapturedExecuteTool {
  const seen: CodemodeSurface[] = [];

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

      if (!first) throw new Error('the eval builder was never called');

      return first;
    },
  };
}

function actorTools(rt: ActorToolsetDeps['rt'], deps: Pick<ActorToolsetDeps, 'craftedToolExecute' | 'codemode'>) {
  // The runtime's own actor: a claim is keyed by its owner.
  return buildActorTools({
    rt,
    history: storesFor(rt).history,
    effectClaims: { sql: rt.storage.sql, actor: rt.actor, turnId: () => 'turn-1' },
    ...deps,
  });
}

describe('Phase D — crafted tools reach the eval builder under tools.*', () => {
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
    actorTools(rt, { craftedToolExecute: factory, codemode: capture.builder });

    const captured = capture.surface();
    // The crafted set is read per execute, so a tool crafted mid-turn is callable on the next call.
    expect(factoryCallCount).toBe(0);

    const resolved = captured.craftedTools();
    expect(Object.keys(resolved)).toContain('double');
    // The builder sees the finished native surface it declares as `tools.*`.
    expect(Object.keys(captured.native)).toEqual(expect.arrayContaining(['shell', 'file', 'memory', 'tasks']));

    const doubleEntry = resolved.double;
    expect(doubleEntry).toBeDefined();
    expect(doubleEntry.description).toBe('Doubles its numeric argument');
    expect(doubleEntry.execute).toBeFunction();

    // The executor factory ran once for this tool, per resolution.
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
      codemode: capture.builder,
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
    expect(await after.quadruple.execute(5)).toBe(20);
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

    const factory: CraftedToolExecute = (crafted) => async (arg) => {
      execCalls++;

      if (crafted.name !== 'triple') throw new Error(`unexpected tool ${crafted.name}`);

      return v.parse(v.number(), arg) * 3;
    };

    const capture = captureExecuteTool();
    actorTools(rt, { craftedToolExecute: factory, codemode: capture.builder });

    const tripleExec = capture.surface().craftedTools().triple.execute;
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
    actorTools(rt, { craftedToolExecute: factory, codemode: capture.builder });

    const names = Object.keys(capture.surface().craftedTools());
    expect(factoryCalls).toBe(0);
    expect(names).not.toContain('forgotten');
  });
});
