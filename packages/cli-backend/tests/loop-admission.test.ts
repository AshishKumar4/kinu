/**
 * THE LOOP'S ADMISSION IS DURABLE WITHOUT ITS KICKS.
 *
 * A send that reaches the loop while the slot is held is admitted the moment
 * the slot frees — by the loop's own recheck, not by the one-shot signals
 * that happen to accompany it. Two such signals exist and both are DEAD in
 * every case here: the kick a send makes (`pump()`, a no-op while a pump is
 * running) and the debounced drain timer (the host's `setTimer`, which this
 * suite drops on the floor). What is left is the durable re-drive: the pump's
 * recheck of its queue at turn close, and the next activation's drain of the
 * pending-event ledger at wake. Each case ends at a MODEL CALL carrying the
 * queued text, because 'queued' that never reaches the model is the defect
 * measured live (kinu-logs/bgjob-wake).
 *
 * Red if the re-drive is removed: a pump that ran one item per kick, or a
 * wake that did not read the ledger, leaves the queued turn where the dead
 * kick left it.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { scratchPath } from '@kinu.run/test-utils';
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

/** The last user line of a prompt that is a MESSAGE — the text the turn was
 *  opened for — skipping the runtime's own context blocks, which ride the
 *  prompt as user lines too. */
function askedFor(prompt: ReadonlyArray<unknown>): string {
  const lines = prompt.flatMap((message) => {
    const user = v.safeParse(UserLineSchema, message);

    if (!user.success) return [];
    const { content } = user.output;

    return [Array.isArray(content) ? content.flatMap((part) => part.type === 'text' ? [part.text ?? ''] : []).join('') : content];
  });

  return lines.filter((line) => !line.startsWith('<') && !line.startsWith('[')).at(-1) ?? '';
}

/** Call one streams a delta and PARKS until `release` — the slot held. Every
 *  later call answers at once. `asked` records what each call was opened for. */
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

/** The loop's host with its debounced drain timer DEAD: a scheduled drain
 *  never fires, so nothing but the loop's own re-drive can admit what waits. */
class DroppedTimerSession extends LocalAgentSession {
  override setTimer(): void {}
}

async function waitFor(pred: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 5000;

  while (!pred()) {
    if (Date.now() > until) throw new Error(`waitFor: ${what}`);
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 5);
    await tick.promise;
  }
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
    const rt = createCLIRuntime(db, { dbPath: db.filename, llm: DUMMY_LLM });
    const gate = Promise.withResolvers<void>();
    const asked: string[] = [];
    const events: SessionEvent[] = [];
    const session = new DroppedTimerSession({ rt, db, model: holdingModel(gate.promise, asked), noAutoEvolve: true, onEvent: (event) => events.push(event) });

    // The slot is held: the user turn is inside its parked model call.
    const userTurn = session.send('hold the slot');
    await waitFor(() => events.some((event) => event.type === 'text-delta'), 'the held turn never reached its model call');

    // The wake arrives at the loop's admission while the slot is held. Its
    // kick is a no-op (a pump is running) and the drain timer is dead: the
    // only thing that can run it is the recheck when the slot frees.
    const wake = session.enqueueTurn({
      text: WAKE_TEXT,
      idempotencyKey: 'bg:bgjob-held',
      metadata: { kinuEvent: 'background_job', jobId: 'bgjob-held', kind: 'run', status: 'completed' },
    });

    expect(asked).toEqual(['hold the slot']);

    // The slot frees.
    gate.resolve();
    await userTurn;

    // The queued wake ran next, as its own turn, and reached the model with
    // the runner's message.
    await expect(wake).resolves.toEqual({ status: 'queued' });
    await waitFor(() => events.filter((event) => event.type === 'turn-end').length === 2, 'the woken turn never closed');
    expect(asked).toEqual(['hold the slot', WAKE_TEXT]);
    expect(events.filter((event) => event.type === 'turn-start').map((event) => event.kind)).toEqual(['user', 'programmatic']);
    expect(runs(db).map((row) => row.type)).toEqual(['run_start', 'run_end', 'run_start', 'run_end']);

    await session.end();
    db.close();
  });

  test('at wake: the retry a dead process left in the ledger, its drain timer never fired, is admitted by the next activation and reaches a model call', async () => {
    const db = openDb('wake');
    const rt = createCLIRuntime(db, { dbPath: db.filename, llm: DUMMY_LLM });

    // What the runner's compensation writes when a wake could not be delivered
    // — the durable retry row — with the process that wrote it gone before its
    // debounced drain ever fired. This is the ledger as the next activation
    // finds it.
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

    // The next activation, its own drain timer dead too. The wake's recheck of
    // the ledger is what admits the retry: one programmatic turn, opened for the
    // runner's message, reaching the model.
    const gate = Promise.withResolvers<void>();
    gate.resolve();
    const asked: string[] = [];
    const events: SessionEvent[] = [];
    const session = new DroppedTimerSession({ rt, db, model: holdingModel(gate.promise, asked), noAutoEvolve: true, onEvent: (event) => events.push(event) });
    await session.flushPendingDrains();
    await waitFor(() => events.some((event) => event.type === 'turn-end'), 'the retried wake never closed a turn');

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(WAKE_TEXT);
    expect(events.filter((event) => event.type === 'turn-start').map((event) => event.kind)).toEqual(['programmatic']);
    expect(runs(db).map((row) => row.type)).toEqual(['run_start', 'run_end']);

    await session.end();
    db.close();
  });
});
