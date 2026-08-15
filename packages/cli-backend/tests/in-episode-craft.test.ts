// The in-episode craft loop, end to end through the real local backend.
//
// The parts are unit-tested in core; what this pins is that they compose into
// the thing the owner asked for — inside ONE turn, with no user in the loop and
// no turn boundary crossed, the agent builds itself a tool, calls it, the call
// is scored by whether it actually ran, and a tool that keeps failing stops
// being callable before the same turn is over. Real createCLIRuntime (real
// filesystem, real CraftStore, real execute_tools sandbox), fake streaming model.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import { TestLanguageModelV2 } from './test-language-model.js';
import type { LLMProviderConfig, RunEvent } from '@proteus/core';
import { CRAFT_NEUTRAL_PRIOR } from '@proteus/core';
import { createCLIRuntime } from '../src/runtime.js';
import { LocalAgentSession, type SessionEvent } from '../src/local-session.js';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

/** A model that spends one turn issuing `blocks` in order, one execute_tools
 *  call per step, then answers. This is the long-episode shape in miniature:
 *  many steps, one turn, nobody replying. */
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
                type: 'tool-call', toolCallId: `call-${step}`, toolName: 'execute_tools',
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
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT 'default', parent_id TEXT,
    role TEXT NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
  const rt = createCLIRuntime(db, {
    dbPath: `/tmp/proteus-test-${Math.floor(performance.now())}.db`, llm: DUMMY_LLM,
  });
  const events: SessionEvent[] = [];
  const session = new LocalAgentSession({
    rt, db, model: scriptedEpisode(blocks), onEvent: (e) => events.push(e),
  });
  return { db, rt, session, events };
}

function craftScore(db: Database, name: string): { score: number; uses: number } | null {
  return db.query<{ score: number; uses: number }, [string]>(
    'SELECT score, uses FROM craft_scores WHERE tool_name = ?',
  ).get(name);
}

/** The turn's craft record, read back the way an analysis would: through the
 *  session's own run-event reader. The run id is not on the session event
 *  stream, so it comes from the durable log the reader indexes. */
function craftCycleRow(session: LocalAgentSession, db: Database) {
  const row = db.query<{ run_id: string }, []>('SELECT run_id FROM run_events LIMIT 1').get();
  if (!row) throw new Error('craft run-event row is missing');
  const runId = row.run_id;
  return session.getRunEvents(runId)
    .find((e: RunEvent): e is Extract<RunEvent, { type: 'craft_cycle' }> => e.type === 'craft_cycle');
}

const CREATE_DOUBLE =
  'await workspace.createTool("doubleIt", "doubles a number", "async (n) => n * 2"); return "made";';

describe('in-episode craft loop — one turn, no user, no turn boundary', () => {
  test('crafted at one step, called at the next, scored on the call — inside one turn', async () => {
    const { db, session, events } = episode([
      CREATE_DOUBLE,
      'return await codemode.doubleIt(21);',
    ]);

    await session.send('go');

    // Callable in the SAME turn that crafted it — the contract createTool
    // advertises, which the CLI could not honour before.
    const toolResults = events.filter(
      (e): e is Extract<SessionEvent, { type: 'tool-result' }> => e.type === 'tool-result',
    );
    expect(toolResults).toHaveLength(2);
    expect(toolResults[1]!.result).toContain('42');

    // Scored on execution, with no follow-up, no turn boundary and no cadence.
    const score = craftScore(db, 'doubleIt')!;
    expect(score.uses).toBe(1);
    expect(score.score).toBeGreaterThan(CRAFT_NEUTRAL_PRIOR);

    // And the whole loop is legible to a benchmark from the durable log.
    const row = craftCycleRow(session, db)!;
    expect(row.crafted).toEqual(['doubleIt']);
    expect(row.reused).toEqual(['doubleIt']);
    expect(row.returned).toBe(1);
    expect(row.raised).toBe(0);
    expect(row.dropped).toEqual([]);

    await session.end();
  }, 20_000);

  test('a tool that keeps raising stops being callable before the turn is over', async () => {
    const create =
      'await workspace.createTool("brokenIt", "always throws", "async () => { throw new Error(\\"nope\\"); }"); return "made";';
    const call = 'return await codemode.brokenIt();';
    const { db, session, events } = episode([
      create, call, call, call, call,
      // By now the tool is under the injection floor: the sandbox no longer
      // binds it at all, which is a DIFFERENT failure from the tool throwing.
      'return typeof codemode.brokenIt;',
    ]);

    await session.send('go');

    const results = events.filter(
      (e): e is Extract<SessionEvent, { type: 'tool-result' }> => e.type === 'tool-result',
    );
    expect(results).toHaveLength(6);
    // Every call while it was still injected named the tool that raised.
    expect(results[1]!.result).toContain('[crafted:brokenIt]');
    // …and the last step no longer sees it.
    expect(results[5]!.result).toContain('undefined');

    const score = craftScore(db, 'brokenIt')!;
    expect(score.uses).toBe(4);
    expect(score.score).toBeLessThan(0.2);

    const row = craftCycleRow(session, db)!;
    expect(row.raised).toBe(4);
    expect(row.returned).toBe(0);
    expect(row.dropped).toEqual(['brokenIt']);

    await session.end();
  }, 20_000);

  test('with auto-evolution off the tool still works and nothing is scored', async () => {
    const { session } = episode([]);
    await session.end();

    const off = (() => {
      const dbOff = new Database(':memory:');
      dbOff.exec(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT 'default', parent_id TEXT,
        role TEXT NOT NULL, content TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
      const rt = createCLIRuntime(dbOff, {
        dbPath: `/tmp/proteus-test-${Math.floor(performance.now())}.db`, llm: DUMMY_LLM,
      });
      const evs: SessionEvent[] = [];
      return {
        db: dbOff,
        events: evs,
        session: new LocalAgentSession({
          rt, db: dbOff, noAutoEvolve: true, onEvent: (e) => evs.push(e),
          model: scriptedEpisode([CREATE_DOUBLE, 'return await codemode.doubleIt(21);']),
        }),
      };
    })();

    await off.session.send('go');

    // Crafting is a capability, not evolution: the tool is still built and
    // still callable. Only the SCORING is evolution state, and a run that
    // records no evolution state records none of it.
    const results = off.events.filter(
      (e): e is Extract<SessionEvent, { type: 'tool-result' }> => e.type === 'tool-result',
    );
    expect(results[1]!.result).toContain('42');
    expect(craftScore(off.db, 'doubleIt')).toEqual({ score: CRAFT_NEUTRAL_PRIOR, uses: 0 });

    await off.session.end();
    off.db.close();
  }, 20_000);
});
