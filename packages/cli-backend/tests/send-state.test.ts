import { describe, expect, test } from 'bun:test';
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { PendingSendStore } from '@kinu.run/core';
import { AwaitedList } from '@kinu.run/test-utils';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { fakeModel, gatedFactCallStream, setup, steerStatuses, textStream, transcript, turnStarts } from './helpers/local-session';
import { TestLanguageModelV2 } from './test-language-model';

/** Its first answer waits for the test, in one step: what arrives meanwhile is still owed when the turn ends. */
function heldModel() {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  const gate = Promise.withResolvers<void>();
  let calls = 0;

  const model = new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async () => {
      const first = calls++ === 0;

      return {
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          async start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '0' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: 'answered' });

            if (first) await gate.promise;
            controller.enqueue({ type: 'text-end', id: '0' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
            controller.close();
          },
        }),
      };
    },
  });

  return { model, release: () => { gate.resolve(); } };
}

describe('a send asked where it stands, from its durable facts', () => {
  test('it reads running under the turn it opened, then settled with that turn\'s outcome, which awaitSend waits for', async () => {
    const { model, release } = heldModel();
    const { session, events } = setup('unused', model);
    const landing = session.send('hello', { id: 'send-1' });

    await events.until((frames) => frames.some((event) => event.type === 'turn-start'));
    expect(await session.sendState('send-1')).toEqual({ status: 'running', turnId: 'send-1', landed: 'turn' });
    const awaited = session.awaitSend('send-1');

    release();
    await landing;
    expect(await awaited).toEqual({ status: 'settled', turnId: 'send-1', landed: 'turn', outcome: 'completed' });
    expect(await session.sendState('never-sent')).toEqual({ status: 'none' });
    await session.end();
  });

  test('sends a turn ended before reading are owed, then each lands under its own id in the turn that reruns them', async () => {
    const { model, release } = heldModel();
    const { rt, session, events } = setup('unused', model);
    const opening = session.send('start', { id: 'opening' });

    // Past its only step's drain: what arrives now is owed when the turn ends.
    await events.until((frames) => frames.some((event) => event.type === 'text-delta'));
    const first = session.send('one more thing', { id: 'late-1' });
    const second = session.send('and this', { id: 'late-2' });

    await events.until(() => steerStatuses(events).filter((status) => status.status === 'queued').length === 2);
    expect([await session.sendState('late-1'), await session.sendState('late-2')]).toEqual([{ status: 'queued' }, { status: 'queued' }]);

    release();
    await opening;
    await Promise.all([first, second]);
    // Carried into the rerun, not read mid-turn: the rerun's answer is its own.
    expect(await session.awaitSend('late-2')).toEqual({ status: 'settled', turnId: 'late-1', landed: 'turn', outcome: 'completed' });
    expect(await session.sendState('late-1')).toEqual({ status: 'settled', turnId: 'late-1', landed: 'turn', outcome: 'completed' });

    const users = (await transcript(rt)).filter((row) => row.role === 'user').map((row) => [row.id, row.content]);

    expect(users).toEqual([['opening', 'start'], ['late-1', 'one more thing'], ['late-2', 'and this']]);
    await session.end();
  });

  test('a send the running turn read at a step lands mid-turn, under that turn', async () => {
    const gate = Promise.withResolvers<void>();
    const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
    let calls = 0;

    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async () => ({ stream: calls++ === 0 ? gatedFactCallStream('call-1', gate.promise, usage) : textStream('read it', usage) }),
    });

    const { session, events } = setup('unused', model);
    const opening = session.send('start', { id: 'opening' });

    await events.until((frames) => frames.some((event) => event.type === 'tool-call'));
    const steer = session.send('and this', { id: 'spliced' });

    gate.resolve();
    expect(await steer).toBe('mid-turn');
    await opening;
    expect(await session.awaitSend('spliced')).toEqual({ status: 'settled', turnId: 'opening', landed: 'mid-turn', outcome: 'completed' });
    await session.end();
  });

  test('a turn that failed before it admitted a claim is settled by its run\'s end', async () => {
    const { session } = setup('unused', undefined, { profileAuthority: () => { throw new Error('no profile catalog'); } });

    expect(await session.send('hello', { id: 'unprepared' })).toBe('turn');
    expect(await session.awaitSend('unprepared')).toEqual({ status: 'settled', turnId: 'unprepared', landed: 'turn', outcome: 'error' });
    await session.end();
  });

  test('a send a stop handed back reads none, and awaitSend answers so', async () => {
    const { model, release } = heldModel();
    const { session, events } = setup('unused', model);
    const opening = session.send('long task', { id: 'opening' });

    await events.until((frames) => frames.some((event) => event.type === 'text-delta'));
    const steer = session.send('change of plans', { id: 'returned' });

    await events.until(() => steerStatuses(events).some((status) => status.status === 'queued'));
    const awaited = session.awaitSend('returned');

    expect(session.interrupt()).toEqual(['change of plans']);
    await expect(steer).rejects.toThrow(/stopped before the agent read this message/);
    expect(await awaited).toEqual({ status: 'none' });
    release();
    await opening;
    await session.end();
  });
});

describe('a send its process died owing', () => {
  /** A reservation the dead process acknowledged, and the next process that restores it. */
  function restored(rows: readonly { readonly id: string; readonly text: string; readonly turnId: string | null }[]) {
    const { db, rt, session } = setup('unused');
    const pending = new PendingSendStore(rt.storage.sql, rt.actor.actorId);

    for (const row of rows) pending.reserve({ ...row, mode: 'build' });
    const events = new AwaitedList<SessionEvent>();
    const next = new LocalAgentSession({ rt, db, model: fakeModel('restored answer'), onEvent: (event) => events.push(event) });

    return { rt, session, next, events };
  }

  test('an idle one opens under its own id', async () => {
    const { rt, session, next, events } = restored([{ id: 'idle-1', text: 'queued behind nothing', turnId: null }]);

    expect(await next.awaitSend('idle-1')).toEqual({ status: 'settled', turnId: 'idle-1', landed: 'turn', outcome: 'completed' });
    expect(turnStarts(events).map((start) => start.turnId)).toEqual(['idle-1']);
    expect((await transcript(rt)).filter((row) => row.role === 'user').map((row) => row.id)).toEqual(['idle-1']);
    await session.end();
    await next.end();
  });

  test('those bound to a dead turn rerun together, each under its own id', async () => {
    const { rt, session, next } = restored([
      { id: 'dead-1', text: 'first words', turnId: 'dead-turn' },
      { id: 'dead-2', text: 'second words', turnId: 'dead-turn' },
    ]);

    expect(await next.awaitSend('dead-2')).toEqual({ status: 'settled', turnId: 'dead-1', landed: 'turn', outcome: 'completed' });

    const users = (await transcript(rt)).filter((row) => row.role === 'user').map((row) => [row.id, row.content]);

    expect(users).toEqual([['dead-1', 'first words'], ['dead-2', 'second words']]);
    await session.end();
    await next.end();
  });
});
