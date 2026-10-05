
/**
 * A send reaching the loop while the slot is held is admitted by the loop's durable re-drive (turn-close recheck,
 * wake-time ledger drain), with both one-shot kicks dead. Red if the re-drive is removed.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { AwaitedList, scratchPath, scratchDir } from '@kinu.run/test-utils';
import { initWorkspaceSchema, type LLMProviderConfig } from '@kinu.run/core';
import type { LanguageModelV2Usage } from '@ai-sdk/provider';
import { EventLog } from '../../core/src/events/hub/index';
import { createCLIRuntime, makeSqlExec, makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { TestLanguageModelV2 } from './test-language-model';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

const USAGE: LanguageModelV2Usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

const WAKE_TEXT = 'Background run job bgjob-held completed. Read the full result with agent.jobResult(\'bgjob-held\').';

const UserLineSchema = v.object({
  role: v.literal('user'),
  content: v.union([v.string(), v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) }))]),
});

/** The last user line that is a message, skipping runtime context blocks that also ride as user lines. */
function askedFor(prompt: ReadonlyArray<unknown>): string {
  const lines = prompt.flatMap((message) => {
    const user = v.safeParse(UserLineSchema, message);

    if (!user.success) return [];
    const { content } = user.output;

    return [Array.isArray(content) ? content.flatMap((part) => part.type === 'text' ? [part.text ?? ''] : []).join('') : content];
  });

  return lines.filter((line) => !line.startsWith('<') && !line.startsWith('[')).at(-1) ?? '';
}

/** Call one streams a delta and parks until `release`; later calls answer at once. */
function holdingModel(release: Promise<void>, asked: string[]): TestLanguageModelV2 {
  let calls = 0;

  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async ({ prompt }) => {
      calls += 1;
      const first = calls === 1;
      asked.push(askedFor(prompt));

      return {
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '0' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: first ? 'holding' : 'answered' });

            if (first) await release;
            controller.enqueue({ type: 'text-end', id: '0' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage: USAGE });
            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}

/** The loop's host with its debounced drain timer dead. */
class DroppedTimerSession extends LocalAgentSession {
  override setTimer(): void {}
}


function openDb(name: string): Database {
  const db = new Database(scratchPath('loop-admission', `${name}.db`));
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));

  return db;
}

function runs(db: Database): ReadonlyArray<{ run_id: string; type: string }> {
  return db.query<{ run_id: string; type: string }, []>(
    "SELECT run_id, type FROM run_events WHERE type IN ('run_start', 'run_end') ORDER BY rowid",
  ).all();
}

describe('the loop admits a send queued while the slot is held, with every one-shot kick dead', () => {
  test('at turn close: the pump\'s own recheck runs the queued wake, which reaches a model call', async () => {
    const db = openDb('turn-close');
    const rt = createCLIRuntime(db, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });
    const gate = Promise.withResolvers<void>();
    const asked: string[] = [];
    const events = new AwaitedList<SessionEvent>();
    rt.actor.config.setLearning(false);
    const session = new DroppedTimerSession({ rt, db, model: holdingModel(gate.promise, asked), onEvent: (event) => events.push(event) });

    const userTurn = session.send('hold the slot', { id: crypto.randomUUID() });
    await events.until((frames) => frames.some((event) => event.type === 'text-delta'));

    const wake = session.enqueueTurn({
      text: WAKE_TEXT,
      idempotencyKey: 'bg:bgjob-held',
      metadata: { kinuEvent: 'background_job', jobId: 'bgjob-held', kind: 'run', status: 'completed' },
    });

    expect(asked).toEqual(['hold the slot']);

    gate.resolve();
    await userTurn;

    await expect(wake).resolves.toEqual({ status: 'queued' });
    await events.until(() => events.items.filter((event) => event.type === 'turn-end').length === 2);
    expect(asked).toEqual(['hold the slot', WAKE_TEXT]);
    expect(events.items.filter((event) => event.type === 'turn-start').map((event) => event.kind)).toEqual(['user', 'programmatic']);
    expect(runs(db).map((row) => row.type)).toEqual(['run_start', 'run_end', 'run_start', 'run_end']);

    await session.end();
    db.close();
  });

  test('at wake: the retry a dead process left in the ledger, its drain timer never fired, is admitted by the next activation and reaches a model call', async () => {
    const db = openDb('wake');
    const rt = createCLIRuntime(db, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });

    // The runner's durable retry row, left by a process gone before its debounced drain fired.
    new EventLog(makeSqlExec(db), rt.actor).publish({
      descriptor: {
        ingress: 'timer_alarm',
        variant: 'timer',
        payload: {
          trigger_id: 'bg:bgjob-held',
          scheduled_fire_at: 1_700_000_000_000,
          label: WAKE_TEXT,
          user_payload: { kinuEvent: 'background_job', kinuMode: 'build', jobId: 'bgjob-held', kind: 'run', status: 'completed' },
        },
        trigger_creator_trust: 'self',
      },
      now: Date.now(),
    });

    const gate = Promise.withResolvers<void>();
    gate.resolve();
    const asked: string[] = [];
    const events = new AwaitedList<SessionEvent>();
    rt.actor.config.setLearning(false);
    const session = new DroppedTimerSession({ rt, db, model: holdingModel(gate.promise, asked), onEvent: (event) => events.push(event) });
    await session.flushPendingDrains();
    await events.until((frames) => frames.some((event) => event.type === 'turn-end'));

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(WAKE_TEXT);
    expect(events.items.filter((event) => event.type === 'turn-start').map((event) => event.kind)).toEqual(['programmatic']);
    expect(runs(db).map((row) => row.type)).toEqual(['run_start', 'run_end']);

    await session.end();
    db.close();
  });
});
