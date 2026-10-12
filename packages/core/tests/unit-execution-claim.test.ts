/**
 * An execution is claimed as it opens (design v2 §2-§3): its claim, `preparing`, and its epoch exist before anything of
 * it is prepared, the epoch is the agent's own sequence over all its turns, and a preparation that fails settles that
 * claim `error`. A Stop that comes as it opens claims and prepares nothing, and the turn ends as a stopped one.
 */
import { expect, test } from 'bun:test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { KinuError } from '../src/obs/error';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import { sessionFixture } from './helpers-session';

function answering() {
  const asked = { count: 0 };

  const model = scriptedTurnModel({ doGenerate: async () => {
    asked.count += 1;

    return {
      content: [{ type: 'text', text: 'done' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
      warnings: [],
    };
  } });

  return { model, asked };
}

test('a turn is claimed preparing before it is prepared, and a failed preparation settles that claim error', async () => {
  const seen: unknown[] = [];

  const fixture = await sessionFixture({
    model: answering().model,
    ports: {
      prepareTurn: async (_item, lease) => {
        seen.push(fixture.actor.stores.claims.read(lease.turnId));

        throw new KinuError('unavailable', 'the profile catalog could not be read');
      },
    },
  });

  try {
    await fixture.chat.send('plan the quarterly offsite', { id: 'q-1' });

    expect(seen).toEqual([expect.objectContaining({ turnId: 'q-1', status: 'preparing', outcome: null, program: null })]);
    expect(fixture.actor.stores.claims.read('q-1')).toMatchObject({ status: 'settled', outcome: 'error' });
  } finally { fixture.close(); }
});

test("an execution's epoch is the agent's own sequence, over all its turns", async () => {
  const fixture = await sessionFixture({ model: answering().model });

  try {
    await fixture.chat.send('first', { id: 't-1' });
    await fixture.chat.send('second', { id: 't-2' });
    const [first, second] = [fixture.actor.stores.claims.read('t-1'), fixture.actor.stores.claims.read('t-2')];

    expect([first?.outcome, second?.outcome]).toEqual(['completed', 'completed']);
    expect((second?.epoch ?? 0) > (first?.epoch ?? 0)).toBe(true);
  } finally { fixture.close(); }
});

test('a Stop as a turn opens claims and prepares nothing, and the turn ends stopped with the owner\'s words kept', async () => {
  const { model, asked } = answering();
  const opening = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  let prepared = 0;
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
      prepareTurn: async () => {
        prepared += 1;

        throw new KinuError('unavailable', 'a stopped turn was prepared');
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

    expect({ prepared, asked: asked.count, claim: fixture.actor.stores.claims.read('s-1') }).toEqual({ prepared: 0, asked: 0, claim: null });
    expect([question?.id, question?.role, after.filter((row) => row.role === 'assistant' && row.parts.length > 0)]).toEqual(['s-1', 'user', []]);
  } finally { fixture.close(); }
});

test("a run delivered while a chat turn runs is claimed only once the turn's claim settled, later in the agent's sequence", async () => {
  const asked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const claimedRuns: { readonly epoch: number; readonly chatEpoch: number | undefined; readonly chatOutcome: string | null | undefined }[] = [];

  const model = scriptedTurnModel({ doGenerate: async () => {
    asked.resolve();
    await release.promise;

    return {
      content: [{ type: 'text', text: 'done' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
      warnings: [],
    };
  } });

  const fixture = await sessionFixture({
    model,
    ports: {
      // The run's host claims its first round as a delivered run's does, before its preparation.
      runs: {
        run: async (run, _signal, retire) => {
          const chat = fixture.actor.stores.claims.read('c-1');
          const reserved = fixture.actor.session.reserveExecution({ turnId: run.id, runId: run.task.runId }, run.task.mode);

          claimedRuns.push({ epoch: reserved.epoch, chatEpoch: chat?.epoch, chatOutcome: chat?.outcome });
          fixture.actor.session.settleReserved(reserved, 'completed');
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
    expect(claimedRuns).toEqual([]);

    release.resolve();
    await sending;
    await fixture.chat.pumpPromise;
    const [claimed] = claimedRuns;

    expect(claimed?.chatOutcome).toBe('completed');
    expect((claimed?.epoch ?? 0) > (claimed?.chatEpoch ?? Infinity)).toBe(true);
  } finally { fixture.close(); }
});

