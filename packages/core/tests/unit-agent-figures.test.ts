// Defends: the figures an agent reports at each turn's end (tokens, dollars, active time, the prompt-cache EMA), and so
// the roster's, drifting from what they were for the same history once they stop re-reading the whole of it.
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestActors } from '@kinu.run/test-utils';
import { makeExecRaw, makeSql } from './helpers';
import type { ActorHandle } from '../src/identity/actor-handle';
import type { SqlExecutor } from '../src/types/primitives';
import { initRunEventTables, RunEventRecorder } from '../src/events/recorder';
import { classifyRunEnd, closeTurnRun, openTurnRun } from '../src/orchestrator/turn-lifecycle';
import { initAgentFiguresTable, readAgentFigures, recordAgentFigures, reportedAgentFigures } from '../src/read-models/agent-figures';

afterEach(() => { setSystemTime(); });

/**
 * 150 turns of main's, three steps each: 450 steps, past the 400 the EMA was once summarized over. Some steps are cold,
 * unpriced or unmeasured, every tenth turn compacts (a model call: spent, never in the EMA), each turn's end carries the
 * turn's own usage (never spent twice), and a hired agent works every third turn in the same database. Prices are
 * decimals no double holds, and each step takes a different number of milliseconds.
 */
function recordHistory(main: ActorHandle, hired: ActorHandle, sql: SqlExecutor, turnEnded: (turn: number) => void): void {
  const agents = { main: { actor: main, recorder: new RunEventRecorder(sql, main) }, hired: { actor: hired, recorder: new RunEventRecorder(sql, hired) } };
  let now = Date.parse('2026-09-30T10:00:00.000Z');

  const after = (ms: number): void => {
    now += ms;
    setSystemTime(now);
  };

  const turn = ({ actor, recorder }: { readonly actor: ActorHandle; readonly recorder: RunEventRecorder }, index: number, steps: (runId: string) => void): void => {
    const runId = `${actor.name}-${String(index)}`;

    after(1_000 + (index % 13) * 311);
    openTurnRun(recorder, runId, { agentId: actor.actorId, causedBy: 'chat', userMessage: `question ${String(index)}`, turnIndex: index });
    steps(runId);
    after(250 + (index % 7) * 43);
    closeTurnRun(recorder, runId, { turnIndex: index, usage: { input: 99_999, output: 9_999 }, ...classifyRunEnd({ completed: true, interrupted: false }) });
  };

  for (let index = 0; index < 150; index += 1) {
    turn(agents.main, index, (runId) => {
      for (let stepIndex = 0; stepIndex < 3; stepIndex += 1) {
        const at = index * 3 + stepIndex;
        const input = 2_000 + (at * 31) % 900;
        const output = 40 + (at * 7) % 160;
        const cacheRead = at % 9 === 0 ? 0 : input - 150 - (at * 5) % 200;

        after(700 + (at % 17) * 97);

        if (at % 23 === 0) agents.main.recorder.emit(runId, { type: 'step_finish', stepIndex });
        else if (at % 11 === 0) agents.main.recorder.emit(runId, { type: 'step_finish', stepIndex, usage: { input, output, cacheRead } });
        else agents.main.recorder.emit(runId, { type: 'step_finish', stepIndex, usage: { input, output, cacheRead }, usd: (input * 3 - cacheRead * 2.7 + output * 15) / 1_000_000 });
      }

      if (index % 10 === 9) {
        agents.main.recorder.emit(runId, { type: 'model_call', source: 'compaction', usage: { input: 9_000 + index, output: 700 }, usd: (9_000 + index) * 0.0000041 });
      }
    });

    if (index % 3 === 0) {
      turn(agents.hired, index, (runId) => {
        agents.hired.recorder.emit(runId, { type: 'step_finish', stepIndex: 0, usage: { input: 50_000, output: 5_000, cacheRead: 1_000 }, usd: 0.4 });
      });
    }

    turnEnded(index);
  }
}

test('an agent\'s figures, read at each of its turns\' ends, are the ones a read of its whole history gave', () => {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initRunEventTables(execRaw);
  initAgentFiguresTable(execRaw);
  const actors = createTestActors(sql, execRaw);
  const hired = actors.sibling('hired');
  const reported: unknown[] = [];

  recordHistory(actors.main, hired, sql, (turn) => {
    // As the agent's isolate reports at its turn's end, and the workspace records it for the roster.
    const figures = readAgentFigures(sql, [actors.main.actorId]).get(actors.main.actorId);

    if (figures === undefined) throw new Error('main has figures');
    recordAgentFigures(sql, actors.main.actorId, figures);

    if (turn === 49 || turn === 149) reported.push(reportedAgentFigures(sql, [actors.main.actorId]).get(actors.main.actorId));
  });

  // The hired agent's first read, over its whole history at once.
  reported.push(readAgentFigures(sql, [hired.actorId]).get(hired.actorId));

  // Each read over the whole history, at b9c667740 (armada job 20261010052156-26dea081).
  expect(reported).toEqual([
    { tokens: 416_001, usd: 0.6872543, activeMs: 238_184, cacheEma: 0.809443810982029 },
    { tokens: 1_252_735, usd: 2.0733177, activeMs: 717_300, cacheEma: 0.8793153747723865 },
    { tokens: 2_750_000, usd: 20, activeMs: 18_821, cacheEma: 0.02 },
  ]);
});

test("the cache EMA reads the newest 400 steps, so steps that reported no cache use push a measured one out", () => {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initRunEventTables(execRaw);
  initAgentFiguresTable(execRaw);
  const { main } = createTestActors(sql, execRaw);
  const recorder = new RunEventRecorder(sql, main);
  const ema = () => readAgentFigures(sql, [main.actorId]).get(main.actorId)?.cacheEma;

  openTurnRun(recorder, 'sparse', { agentId: main.actorId, causedBy: 'chat', userMessage: 'sparse', turnIndex: 0 });
  recorder.emit('sparse', { type: 'step_finish', stepIndex: 0, usage: { input: 1_000, cacheRead: 1_000 } });
  expect(ema()).toBe(1);

  for (let stepIndex = 1; stepIndex <= 400; stepIndex += 1) recorder.emit('sparse', { type: 'step_finish', stepIndex });

  // Read once at the end of the 400, and once a step at a time across them: the same window either way.
  expect(ema()).toBeNull();
  recorder.emit('sparse', { type: 'step_finish', stepIndex: 401, usage: { input: 1_000, cacheRead: 0 } });
  expect(ema()).toBe(0);
});
