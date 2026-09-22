// The in-episode craft loop through the real local backend: within one turn a crafted tool is callable,
// scored on execution, and dropped once it keeps failing.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import { TestLanguageModelV2 } from './test-language-model';
import type { LLMProviderConfig, RunEvent } from '@kinu.run/core';
import { initWorkspaceSchema } from '@kinu.run/core';
import { CRAFT_NEUTRAL_PRIOR } from '@kinu.run/core';
import { createCLIRuntime, type CLIRuntime , makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { present, scratchPath } from '@kinu.run/test-utils';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

/** Spends one turn issuing `blocks` in order, one eval call per step, then answers. */
function scriptedEpisode(blocks: readonly string[]): LanguageModel {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  let step = 0;

  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async () => {
      const code = blocks[step];
      step += 1;

      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });

            if (code !== undefined) {
              controller.enqueue({
                type: 'tool-call', toolCallId: `call-${step}`, toolName: 'eval',
                input: JSON.stringify({ code }),
              });
              controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
            } else {
              controller.enqueue({ type: 'text-start', id: '0' });
              controller.enqueue({ type: 'text-delta', id: '0', delta: 'done' });
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
            }

            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}

function episode(blocks: readonly string[]) {
  // The declared path, not `:memory:`: `createCLIRuntime` refuses a mismatched path (`requireLocalDatabasePath`).
  const db = new Database(scratchPath('in-episode-craft', 'agent.db'), { create: true });
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));

  const rt = createCLIRuntime(db, {
    dbPath: db.filename, llm: DUMMY_LLM,
  });

  const events: SessionEvent[] = [];

  const session = new LocalAgentSession({
    rt, db, model: scriptedEpisode(blocks), onEvent: (e) => events.push(e),
  });

  return { db, rt, session, events };
}

function craftScore(db: Database, name: string): { score: number; uses: number } | null {
  return db.query<{ score: number; uses: number }, [string]>(
    'SELECT score, uses FROM crafted_tools WHERE name = ?',
  ).get(name);
}

function craftCycleRow(session: LocalAgentSession, rt: CLIRuntime, db: Database) {
  // `run_events` is actor-scoped, so the run id comes from this session's own actor.
  const row = db.query<{ run_id: string }, [string]>(
    'SELECT run_id FROM run_events WHERE actor_id = ? LIMIT 1',
  ).get(rt.actor.actorId);

  if (!row) throw new Error('craft run-event row is missing');
  const runId = row.run_id;

  return session.getRunEvents(runId)
    .find((e: RunEvent): e is Extract<RunEvent, { type: 'craft_cycle' }> => e.type === 'craft_cycle');
}

const CREATE_DOUBLE =
  'await workspace.createTool("doubleIt", "doubles a number", "async (n) => n * 2"); return "made";';

describe('in-episode craft loop — one turn, no user, no turn boundary', () => {
  test('crafted at one step, called at the next, scored on the call — inside one turn', async () => {
    const { db, rt, session, events } = episode([
      CREATE_DOUBLE,
      'return await tools.doubleIt(21);',
    ]);

    await session.send('go');

    const toolResults = events.filter(
      (e): e is Extract<SessionEvent, { type: 'tool-result' }> => e.type === 'tool-result',
    );

    expect(toolResults).toHaveLength(2);
    expect(toolResults[1].result).toContain('42');

    const score = present(craftScore(db, 'doubleIt'), 'the crafted-tool score row for doubleIt');
    expect(score.uses).toBe(1);
    expect(score.score).toBeGreaterThan(CRAFT_NEUTRAL_PRIOR);

    const row = present(craftCycleRow(session, rt, db), 'the turn\'s craft_cycle run event');
    expect(row.crafted).toEqual(['doubleIt']);
    expect(row.reused).toEqual(['doubleIt']);
    expect(row.returned).toBe(1);
    expect(row.raised).toBe(0);
    expect(row.dropped).toEqual([]);

    await session.end();
  });

  test('a tool that keeps raising stops being callable before the turn is over', async () => {
    const create =
      'await workspace.createTool("brokenIt", "always throws", "async () => { throw new Error(\\"nope\\"); }"); return "made";';

    const call = 'return await tools.brokenIt();';

    const { db, rt, session, events } = episode([
      create, call, call, call, call,
      // Under the injection floor the sandbox no longer binds the tool, a different failure from it throwing.
      'return typeof tools.brokenIt;',
    ]);

    await session.send('go');

    const results = events.filter(
      (e): e is Extract<SessionEvent, { type: 'tool-result' }> => e.type === 'tool-result',
    );

    expect(results).toHaveLength(6);
    expect(results[1].result).toContain('[crafted:brokenIt]');
    expect(results[5].result).toContain('undefined');

    const score = present(craftScore(db, 'brokenIt'), 'the crafted-tool score row for brokenIt');
    expect(score.uses).toBe(4);
    expect(score.score).toBeLessThan(0.2);

    const row = present(craftCycleRow(session, rt, db), 'the turn\'s craft_cycle run event');
    expect(row.raised).toBe(4);
    expect(row.returned).toBe(0);
    expect(row.dropped).toEqual(['brokenIt']);

    await session.end();
  });

  test('with auto-evolution off the tool still works and nothing is scored', async () => {
    const { session } = episode([]);
    await session.end();

    const off = (() => {
      const dbOff = new Database(scratchPath('in-episode-craft-off', 'agent.db'), { create: true });
      initWorkspaceSchema(makeWorkspaceSchemaSql(dbOff));

      const rt = createCLIRuntime(dbOff, {
        dbPath: dbOff.filename, llm: DUMMY_LLM,
      });

      const evs: SessionEvent[] = [];

      return {
        db: dbOff,
        events: evs,
        session: new LocalAgentSession({
          rt, db: dbOff, noAutoEvolve: true, onEvent: (e) => evs.push(e),
          model: scriptedEpisode([CREATE_DOUBLE, 'return await tools.doubleIt(21);']),
        }),
      };
    })();

    await off.session.send('go');

    // Crafting is a capability, not evolution; only the scoring is evolution state.
    const results = off.events.filter(
      (e): e is Extract<SessionEvent, { type: 'tool-result' }> => e.type === 'tool-result',
    );

    expect(results[1].result).toContain('42');
    expect(craftScore(off.db, 'doubleIt')).toEqual({ score: CRAFT_NEUTRAL_PRIOR, uses: 0 });

    await off.session.end();
    off.db.close();
  });
});
