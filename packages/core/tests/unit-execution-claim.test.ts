/**
 * An execution is claimed as it opens (design v2 §2-§3), before anything of it is prepared: a preparation that fails ends
 * its turn, its room told, and leaves the agent free for the next; a Stop that comes as it opens ends it with nothing
 * asked of the model and the owner's words kept; and a run delivered while a chat turn runs waits for that turn's end.
 */
import { expect, test } from 'bun:test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { KinuError } from '../src/obs/error';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import { sessionFixture } from './helpers-session';

/** A model that answers each call `done`, after `held` (when given) lets it. */
function answering(held?: () => Promise<void>) {
  const asked = { count: 0 };

  const model = scriptedTurnModel({ doGenerate: async () => {
    asked.count += 1;
    await held?.();

    return {
      content: [{ type: 'text', text: 'done' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
      warnings: [],
    };
  } });

  return { model, asked };
}

test('a turn whose preparation fails ends with its room told, and the next turn runs and is answered', async () => {
  const { model, asked } = answering();
  let failures = 1;

  const fixture = await sessionFixture({
    model,
    aroundPrepare: (prepare) => async (...args) => {
      if (failures-- > 0) throw new KinuError('unavailable', 'the profile catalog could not be read');

      return await prepare(...args);
    },
  });

  try {
    await fixture.chat.send('plan the quarterly offsite', { id: 'q-1' });
    // Its room hears the failure; nothing of it reached the model.
    expect([fixture.events.some((event) => event.type === 'error'), asked.count]).toEqual([true, 0]);

    await fixture.chat.send('plan it again', { id: 'q-2' });
    const answered = (await fixture.actor.stores.history.transcript(CHAT_SESSION_ID).history()).filter((row) => row.role === 'assistant');

    expect(JSON.stringify(answered)).toContain('done');
  } finally { fixture.close(); }
});

test("a Stop as a turn opens asks the model nothing, keeps the owner's words, and the next turn runs", async () => {
  const { model, asked } = answering();
  const opening = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  let firstArm = true;

  const fixture = await sessionFixture({
    model,
    ports: {
      // The turn's open arms its wake: the Stop comes while it does.
      armTurnWake: async () => {
        if (!firstArm) return;
        firstArm = false;
        opening.resolve();
        await stopped.promise;
      },
    },
  });

  try {
    const sending = fixture.chat.send('summarize the ledger', { id: 's-1' });

    await opening.promise;
    fixture.chat.interrupt();
    stopped.resolve();
    // Its send answers as a stopped turn's does; what the turn left is read below.
    await Promise.allSettled([sending]);
    await fixture.chat.pumpPromise;

    const [question, ...after] = await fixture.actor.stores.history.transcript(CHAT_SESSION_ID).history();

    expect([asked.count, question?.id, question?.role, after.filter((row) => row.role === 'assistant' && row.parts.length > 0)]).toEqual([0, 's-1', 'user', []]);

    await fixture.chat.send('summarize it now', { id: 's-2' });
    expect(asked.count).toBe(1);
  } finally { fixture.close(); }
});

test('a run delivered while a chat turn runs starts only once that turn has answered', async () => {
  const asked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: string[] = [];

  const { model } = answering(async () => {
    asked.resolve();
    await release.promise;
    order.push('chat answered');
  });

  const fixture = await sessionFixture({
    model,
    ports: {
      runs: {
        run: async (_run, _signal, retire) => {
          order.push('run started');
          retire();
        },
        refuse: (_run, _failure, retire) => { retire(); },
      },
    },
  });

  try {
    const sending = fixture.chat.send('chat first', { id: 'c-1' });

    await asked.promise;
    expect(await fixture.chat.admitDelivery({
      id: 'run-1', seq: 1, authorship: 'hirer', input: { kind: 'run', task: { sequenceId: 'run-1', runId: 'r-1', body: 'run behind', mode: 'build' } },
    }, 'workspace')).toBe('taken');

    release.resolve();
    await sending;
    await fixture.chat.pumpPromise;

    expect(order).toEqual(['chat answered', 'run started']);
  } finally { fixture.close(); }
});
