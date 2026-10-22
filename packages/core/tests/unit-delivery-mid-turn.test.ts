/**
 * A delivery that reaches a running turn lands at that turn's next step, as its signal did, and opens no turn of its
 * own: a drained batch tells the live turn to act on its events before it finishes, never that they arrived while it
 * was idle, and the live turn's end answers the batch as the batch's own turn would have.
 */
import { expect, test } from 'bun:test';
import { jsonSchema, tool } from 'ai';
import { present, scriptedTurnModel, type ScriptedTurnResult } from '@kinu.run/test-utils';
import { pendingEventsDelivery } from '../src/subagents/deliveries';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import { chatSeed } from '../src/read-models/status';
import { keptMediaName } from '../src/session/chat-media';
import { sessionFixture } from './helpers-session';

const USAGE: ScriptedTurnResult['usage'] = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined },
};

test('an ACTIVE turn absorbs the batch mid-turn — no new turn is enqueued', async () => {
  const { fixture, sent, released, prompts } = await watchedTurn('Deployed; the webhook is handled.');

  try {
    fixture.eventLog.publish({
      descriptor: {
        ingress: 'webhook_hmac', variant: 'webhook', auth_outcome: 'verified', webhook_id: 'w1',
        payload: { webhook_id: 'w1', http_method: 'POST', http_headers: {}, body: { x: 1 }, delivery_id: 'd1' },
      },
      now: 1,
    });
    const batch = present(pendingEventsDelivery(fixture.eventLog, Date.now()), 'the drained batch');

    expect(await fixture.chat.admitDelivery({ ...batch, seq: 1 }, 'workspace')).toBe('taken');
    released.resolve();
    expect(await sent).toBe('turn');
    expect(await fixture.chat.awaitSend('owner-1')).toMatchObject({ status: 'settled' });

    // The live turn's next step read the batch, worded for a turn that is working.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('arrived while you were working');
    expect(prompts[1]).not.toContain('arrived while you were idle');
    // No turn of its own: the conversation is the owner's message and its one answer.
    expect((await chatSeed(fixture.actor.stores.history.transcript(CHAT_SESSION_ID), keptMediaName)).messages.map((entry) => entry.role)).toEqual(['user', 'assistant']);
    // The live turn's end answered the batch: its events stay bound to the batch's turn, their lease closed.
    expect(fixture.actor.runtime.storage.sql<{ consumed_at: number | null }>`
      SELECT consumed_at FROM agent_log WHERE turn_id = ${batch.id} AND kind = 'event'`).toEqual([{ consumed_at: null }]);
  } finally {
    released.resolve();
    fixture.close();
  }
});

/** A turn the model asks to `watch`, whose tool holds until released: the window a delivery lands in mid-turn. */
async function watchedTurn(answer = 'Done.') {
  const watching = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const prompts: string[] = [];

  const model = scriptedTurnModel({ doGenerate: (options): ScriptedTurnResult => {
    prompts.push(JSON.stringify(options.prompt));

    return prompts.length === 1
      ? { content: [{ type: 'tool-call', toolName: 'watch', toolCallId: 'call-watch', input: '{}' }], finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE, warnings: [] }
      : { content: [{ type: 'text', text: answer }], finishReason: { unified: 'stop', raw: undefined }, usage: USAGE, warnings: [] };
  } });

  const watch = tool({
    description: 'Watch', inputSchema: jsonSchema({ type: 'object' }),
    execute: async () => {
      watching.resolve();
      await released.promise;

      return { ok: true };
    },
  });

  const fixture = await sessionFixture({ model, tools: { watch } });
  const sent = fixture.chat.send('Watch.', { id: 'owner-1' });

  await watching.promise;

  return { fixture, sent, released, prompts };
}

const SIGNAL = { id: 'durable-signal-1', seq: 1, authorship: 'hirer' as const, input: { kind: 'turn' as const, text: 'MIDTURN_DELIVERY_MARKER' } };

test('a delivery a running turn takes is taken once: its replay answers duplicate and the model reads it once', async () => {
  const { fixture, sent, released, prompts } = await watchedTurn();

  try {
    expect(await fixture.chat.admitDelivery(SIGNAL, 'workspace')).toBe('taken');
    // The workspace lost the answer and asks again: the facet already holds it.
    expect(await fixture.chat.admitDelivery(SIGNAL, 'workspace')).toBe('duplicate');
    released.resolve();
    await sent;
    await fixture.chat.awaitSend('owner-1');

    expect(prompts.reduce((copies, prompt) => copies + (prompt.match(/MIDTURN_DELIVERY_MARKER/g)?.length ?? 0), 0)).toBe(1);
  } finally {
    released.resolve();
    fixture.close();
  }
});

test('Stop cancels a delivery the stopped turn took and had not read: nothing runs it after', async () => {
  const { fixture, sent, released } = await watchedTurn();

  try {
    expect(await fixture.chat.admitDelivery(SIGNAL, 'workspace')).toBe('taken');
    fixture.chat.interrupt();
    released.resolve();
    await sent;
    await fixture.chat.awaitSend('owner-1');

    expect(fixture.seats.enqueued.filter((turn) => turn.text.includes('MIDTURN_DELIVERY_MARKER'))).toEqual([]);
  } finally {
    released.resolve();
    fixture.close();
  }
});

test('a delivery that arrives after the Stop that cut it off, and after new input resumed the agent, is refused and never read', async () => {
  const { fixture, sent, released, prompts } = await watchedTurn();
  const delivered = (id: string, seq: number, text: string) => ({ id, seq, authorship: 'hirer' as const, input: { kind: 'turn' as const, text } });

  try {
    // The workspace's Stop cancelled what it owed through 4, among them one already on its way here.
    fixture.chat.interrupt({ producer: 'workspace', seq: 4 });
    released.resolve();
    await sent;

    // New input resumes the agent, and runs.
    expect(await fixture.chat.admitDelivery(delivered('after-stop', 5, 'AFTER_STOP_MARKER'), 'workspace')).toBe('taken');
    await fixture.chat.pumpPromise;
    // The one on its way arrives only now.
    expect(await fixture.chat.admitDelivery(delivered('before-stop', 4, 'BEFORE_STOP_MARKER'), 'workspace')).toBe('cancelled');
    await fixture.chat.pumpPromise;

    expect(prompts.some((prompt) => prompt.includes('AFTER_STOP_MARKER'))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes('BEFORE_STOP_MARKER'))).toBe(false);
  } finally {
    released.resolve();
    fixture.close();
  }
});
