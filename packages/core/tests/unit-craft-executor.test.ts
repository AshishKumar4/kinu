/** A stored tool is filtered by effective score, handed to the program as its source, compiled in the program's own
 *  scope and invoked as `tools.<name>`; each backend's program runner is tested in that backend. */

import { describe, test, expect } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import { createTestRuntime, conversationsFor, actorJobsFor } from './helpers';
import { programCodemode } from './helpers-program';
import {
  buildActorTools,
  craftFailureMarker,
  selectInjectableCraftedTools,
  type ActorToolsetDeps,
  type CodemodeSurface,
  type JsonValue,
} from '../src/index';
import { tool, jsonSchema } from 'ai';
import * as v from 'valibot';

const ExecuteResultSchema = v.object({
  result: v.optional(v.union([v.string(), v.number(), v.boolean(), v.null()])),
  error: v.optional(v.string()),
});

/** The surface the eval builder was handed. */
function capturedSurface(rt: ActorToolsetDeps['rt']): () => CodemodeSurface {
  const seen: CodemodeSurface[] = [];

  actorTools(rt, {
    codemode: (surface) => {
      seen.push(surface);

      return tool({ description: 'capture', inputSchema: jsonSchema({ type: 'object' }), execute: async () => null });
    },
  });

  return () => {
    const first = seen[0];

    if (!first) throw new Error('the eval builder was never called');

    return first;
  };
}

/** An actor surface over `rt` whose sandbox is `codemode`. */
function actorTools(rt: ActorToolsetDeps['rt'], deps: Pick<ActorToolsetDeps, 'codemode'>) {
  return buildActorTools({ rt, effectClaims: { sql: rt.storage.sql, actor: rt.actor, turnId: () => 'turn-1', durable: () => Promise.resolve() }, jobs: actorJobsFor(rt), ...deps, conversations: conversationsFor(rt) }).turn;
}

async function runProgram(rt: ActorToolsetDeps['rt'], code: string) {
  const tools = actorTools(rt, { codemode: programCodemode() });

  return v.parse(ExecuteResultSchema, await toolExecute<{ code: string }, JsonValue>(tools.eval)({ code }));
}

describe('crafted-tool execution integration', () => {
  test('the program receives the eligible names, normalized source and descriptions both backends select', () => {
    const { rt } = createTestRuntime();

    for (const [name, code] of [
      ['healthy', '  async () => 1  '], ['shell', 'async () => 2'],
      ['mcp_shadow', 'async () => 3'], ['empty', '   '], ['comment', '  // disabled'],
      ['retired', 'async () => 4'],
    ] as const) {
      rt.craftStore.create({ name, code, description: '' });
    }

    void rt.storage.sql`UPDATE crafted_tools SET score = 0.01, last_used_at = ${Date.now()} WHERE name = 'retired'`;
    const crafted = capturedSurface(rt)().craftedTools();

    expect(crafted).toEqual(selectInjectableCraftedTools(rt.craftStore, rt.storage.sql));
    expect(crafted).toEqual([{ name: 'healthy', code: 'async () => 1', description: 'Crafted tool: healthy' }]);
  });

  test('an unreadable store fails the program instead of silently removing all crafted tools', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.list = () => { throw new Error('crafted store unavailable'); };

    const result = await runProgram(rt, 'return 1;');
    expect(result.error).toContain('crafted store unavailable');
    expect(result.result).toBeUndefined();
  });

  test('tools.<name>(arg) round-trips a stored tool', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({ name: 'double', description: 'doubles its arg', code: 'async (n) => n * 2' });

    expect(await runProgram(rt, 'return await tools.double(21);')).toEqual({ result: 42 });
  });

  test('a crafted tool that raises leaves the program stamped with its identity', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({ name: 'exploder', description: 'always throws', code: 'async () => { throw new Error("inner boom"); }' });

    const tools = actorTools(rt, { codemode: programCodemode() });

    // A binding failure comes back as the call's refusal, as every other program binding's does.
    const { result } = v.parse(v.object({ result: v.object({ success: v.literal(false), error: v.string() }) }),
      await toolExecute<{ code: string }, JsonValue>(tools.eval)({ code: 'return await tools.exploder();' }));

    // The model is told WHICH of its own tools broke, and the in-episode
    // fitness signal reads the same stamp to score that artifact and no other.
    expect(result.error).toContain(craftFailureMarker('exploder'));
    expect(result.error).toContain('inner boom');
    expect(result.error.split(craftFailureMarker('exploder')).length).toBe(2);
  });

  test('a tool that RETURNS normally is not stamped', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({ name: 'quiet', description: 'fine', code: 'async () => "ok"' });

    expect(await runProgram(rt, 'return await tools.quiet();')).toEqual({ result: 'ok' });
  });

  test.each([
    ['a throwing body', 'async () => { throw new Error("broken body"); }'],
    ['malformed stored source', 'async () => {'],
    ['a non-callable source', '42'],
  ])('one bad crafted tool fails alone: %s', async (_kind, code) => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({ name: 'broken', description: 'broken', code });
    rt.craftStore.create({ name: 'double', description: 'double', code: 'async (n) => n * 2' });
    const tools = actorTools(rt, { codemode: programCodemode() });

    const { result } = v.parse(v.object({ result: v.object({
      before: v.number(), failed: v.object({ success: v.literal(false), error: v.string() }), after: v.number(),
    }) }), await toolExecute<{ code: string }, JsonValue>(tools.eval)({
      code: 'const before = await tools.double(2); const failed = await tools.broken(); const after = await tools.double(3); return { before, failed, after };',
    }));

    expect(result.before).toBe(4);
    expect(result.failed.error).toContain(craftFailureMarker('broken'));
    expect(result.after).toBe(6);
  });

  test('a tool rewritten mid-turn runs its new body in the next program', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({ name: 'identity', description: 'returns arg', code: 'async (x) => x' });
    const tools = actorTools(rt, { codemode: programCodemode() });
    const execute = toolExecute<{ code: string }, JsonValue>(tools.eval);

    expect(await execute({ code: 'return await tools.identity(1);' })).toEqual({ result: 1 });
    rt.craftStore.update('identity', { code: 'async (x) => x + 1' });
    expect(await execute({ code: 'return await tools.identity(2);' })).toEqual({ result: 3 });
  });

  test('low-scoring tools never reach the program', () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({ name: 'noisy', description: 'noisy', code: 'async () => "nope"' });
    void rt.storage.sql`UPDATE crafted_tools SET score = 0.01, last_used_at = ${Date.now()} WHERE name = 'noisy'`;

    expect(capturedSurface(rt)().craftedTools()).toEqual([]);
  });
});
