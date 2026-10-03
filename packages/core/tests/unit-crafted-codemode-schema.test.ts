/**
 * buildActorTools hands crafted tools to the injected eval builder as the sources a program compiles into
 * `tools.<name>()`. The real @cloudflare/codemode is a cf-backend dep, so the resolver is called here as the
 * sandbox would.
 */

import { describe, test, expect } from 'bun:test';
import { jsonSchema, tool } from 'ai';
import { createTestRuntime, conversationsFor, actorJobsFor } from './helpers';
import {
  buildActorTools,
  type ActorToolsetDeps,
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

function actorTools(rt: ActorToolsetDeps['rt'], deps: Pick<ActorToolsetDeps, 'codemode'>) {
  // The runtime's own actor: a claim is keyed by its owner.
  return buildActorTools({
    rt,
    conversations: conversationsFor(rt),
    effectClaims: { sql: rt.storage.sql, actor: rt.actor, turnId: () => 'turn-1', durable: () => Promise.resolve() },
    jobs: actorJobsFor(rt),
    ...deps,
  }).turn;
}

describe('Phase D — crafted tools reach the eval builder under tools.*', () => {
  test('a crafted tool reaches the builder as its source, beside the native surface', () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({ name: 'double', description: 'Doubles its numeric argument', code: 'async (n) => n * 2' });
    const capture = captureExecuteTool();
    actorTools(rt, { codemode: capture.builder });

    const captured = capture.surface();
    expect(captured.craftedTools()).toEqual([{ name: 'double', description: 'Doubles its numeric argument', code: 'async (n) => n * 2' }]);
    // The builder sees the finished native surface it declares as `tools.*`.
    expect(Object.keys(captured.native)).toEqual(expect.arrayContaining(['shell', 'file', 'memory', 'tasks']));
  });

  test('a tool crafted after the toolset was built is in the next resolve', () => {
    const { rt } = createTestRuntime();
    const capture = captureExecuteTool();
    actorTools(rt, { codemode: capture.builder });
    const resolve = capture.surface().craftedTools;
    expect(resolve()).toEqual([]);

    // The in-episode move: the agent crafts a tool mid-turn.
    rt.craftStore.create({ name: 'quadruple', description: 'x4', code: 'async (n) => n * 4' });

    expect(resolve().map((crafted) => crafted.name)).toEqual(['quadruple']);
  });

  test('low-score tool is filtered BEFORE reaching the builder', () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({ name: 'forgotten', description: 'old tool', code: 'async () => null' });
    void rt.storage.sql`UPDATE crafted_tools SET score = 0.01, last_used_at = ${Date.now()} WHERE name = 'forgotten'`;
    const capture = captureExecuteTool();
    actorTools(rt, { codemode: capture.builder });

    expect(capture.surface().craftedTools().map((crafted) => crafted.name)).not.toContain('forgotten');
  });
});
