/**
 * An execution is claimed as it opens (design v2 §2-§3), before anything of it is prepared: a preparation that fails ends
 * its turn, its room told, and leaves the agent free for the next; a Stop that comes as it opens ends it with nothing
 * asked of the model and the owner's words kept; a run delivered while a chat turn runs waits for that turn's end; and
 * an answer whose commit is refused leaves its execution's close to the turn's failure, durably; and a turn that ends
 * failed or stopped answers the words it took, so no later start runs them again.
 */
import { expect, test } from 'bun:test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { KinuError } from '../src/obs/error';
import { PendingSendStore } from '../src/orchestrator/inbox';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import { chatSeed } from '../src/read-models/status';
import { keptMediaName } from '../src/session/chat-media';
import { sessionFixture } from './helpers-session';

/** A model that answers each call `done`, after `held` (when given) lets it; `prompts`: what each call was sent. */
function answering(held?: () => Promise<void>) {
  const asked = { count: 0 };
  const prompts: string[] = [];

  const model = scriptedTurnModel({ doGenerate: async (options) => {
    asked.count += 1;
    prompts.push(JSON.stringify(options.prompt));
    await held?.();

    return {
      content: [{ type: 'text', text: 'done' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
      warnings: [],
    };
  } });

  return { model, asked, prompts };
}

/** The owner's words still owed to a turn: what a later start of the agent runs as a new turn. */
function owedWords(fixture: Awaited<ReturnType<typeof sessionFixture>>): string[] {
  return new PendingSendStore(fixture.actor.runtime.storage.sql, fixture.actor.handle.actorId).restore().map((row) => row.id);
}

test('a turn whose preparation fails ends with its room told, its words answered, and the next turn runs and is answered', async () => {
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
    await fixture.chat.pumpPromise;
    // Its room hears the failure; nothing of it reached the model, and no later start runs its words.
    expect([fixture.events.some((event) => event.type === 'error'), asked.count]).toEqual([true, 0]);
    expect({ outcome: fixture.actor.session.claims.read('q-1')?.outcome ?? null, owed: owedWords(fixture) }).toEqual({ outcome: 'error', owed: [] });

    await fixture.chat.send('plan it again', { id: 'q-2' });
    const answered = (await chatSeed(fixture.actor.stores.history.transcript(CHAT_SESSION_ID), keptMediaName)).filter((row) => row.role === 'assistant');

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

    const [question, ...after] = await chatSeed(fixture.actor.stores.history.transcript(CHAT_SESSION_ID), keptMediaName);

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
        run: async (_run, _signal, recordEnd) => {
          order.push('run started');
          (await recordEnd({ refused: { code: 'cancelled', message: 'nothing to run' } }))();
        },
        tell: () => {},
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

test("words sent while a turn opens, before it runs, come back on a Stop, and no turn runs them", async () => {
  const { model, prompts } = answering();
  const handedBack = Promise.withResolvers<string[]>();
  const second = Promise.withResolvers<void>();
  let opened = false;

  const fixture = await sessionFixture({
    model,
    // The first turn is announced as it opens, before anything of it ran: the owner writes again, then stops.
    onEvent: (event) => {
      if (event.type !== 'turn-start' || opened) return;
      opened = true;
      void fixture.chat.send('and the refunds too', { id: 'o-2' }).then(() => { second.resolve(); }, () => { second.resolve(); });
      handedBack.resolve(fixture.chat.interrupt());
    },
  });

  try {
    await Promise.allSettled([fixture.chat.send('summarize the ledger', { id: 'o-1' })]);
    await second.promise;
    await fixture.chat.pumpPromise;

    expect(await handedBack.promise).toEqual(['and the refunds too']);
    expect(prompts.filter((prompt) => prompt.includes('and the refunds too'))).toEqual([]);
  } finally { fixture.close(); }
});

test("a turn whose answer's commit is refused closes its claim and its run as the failure it is", async () => {
  const { model } = answering();
  let refusals = 1;
  let endedRuns = (): number => 0;
  const ended = Promise.withResolvers<void>();

  const fixture = await sessionFixture({
    model,
    // The commit that ends the turn's run is refused once, as storage refuses a COMMIT: everything it wrote rolls back.
    aroundCommit: (commit) => <T>(body: () => T): T => commit(() => {
      const value = body();

      if (refusals > 0 && endedRuns() > 0) {
        refusals -= 1;
        throw new KinuError('io', 'the storage refused the commit');
      }

      return value;
    }),
    onEvent: (event) => { if (event.type === 'turn-end') ended.resolve(); },
  });

  const { sql } = fixture.actor.runtime.storage;

  endedRuns = () => sql<{ n: number }>`SELECT COUNT(*) AS n FROM run_events WHERE type = 'run_end'`[0]?.n ?? 0;

  try {
    await fixture.chat.send('close the books', { id: 'refused-commit' });
    await ended.promise;

    // Its room is told it failed, and its claim and run are closed where a restart reads them: nothing of it runs again.
    expect(fixture.events.some((event) => event.type === 'error')).toBe(true);
    expect(fixture.actor.stores.claims.read('refused-commit')).toMatchObject({ status: 'settled', outcome: 'error' });
    expect([endedRuns(), fixture.actor.stores.eventRecorder.openTurn()]).toEqual([1, null]);
  } finally { fixture.close(); }
});


test("a turn stopped while it prepared answers the words it took: no later start runs them", async () => {
  const preparing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  const fixture = await sessionFixture({
    model: answering().model,
    aroundPrepare: () => async () => {
      preparing.resolve();
      await release.promise;

      throw new KinuError('cancelled', 'Turn s-1 was stopped.');
    },
  });

  try {
    const sending = fixture.chat.send('summarize the ledger', { id: 's-1' });

    await preparing.promise;
    fixture.chat.interrupt();
    release.resolve();
    await Promise.allSettled([sending]);
    await fixture.chat.pumpPromise;

    expect({ outcome: fixture.actor.session.claims.read('s-1')?.outcome ?? null, owed: owedWords(fixture) }).toEqual({ outcome: 'aborted', owed: [] });
  } finally { fixture.close(); }
});

test("a delivered run's kept end whose spilled file cannot be read is told as a refusal, and the other ends with it", async () => {
  const fixture = await sessionFixture({ model: answering().model });

  try {
    const store = new PendingSendStore(fixture.actor.runtime.storage.sql, fixture.actor.handle.actorId);
    const kept = { kinuEvent: 'delivered_run', kinuMode: 'build', kinuRun: 'run-kept' };

    // One end spilled to a file since lost, one kept whole beside it.
    store.reserveTurn({ id: 'lost-end', text: 'Name one way.', metadata: { ...kept, kinuRun: 'run-lost' } });
    store.recordRunEnd('lost-end', { json: null, path: 'payloads/gone.json' });
    store.reserveTurn({ id: 'kept-end', text: 'Name another.', metadata: kept });
    store.recordRunEnd('kept-end', { json: JSON.stringify({ refused: { code: 'cancelled', message: 'stopped' } }), path: null });

    const owed = await fixture.chat.runEnds.owed();

    expect(owed.map(({ id, outcome }) => [id, 'refused' in outcome ? outcome.refused.code : 'ended'])).toEqual([['lost-end', 'missing'], ['kept-end', 'cancelled']]);
  } finally {
    fixture.close();
  }
});
