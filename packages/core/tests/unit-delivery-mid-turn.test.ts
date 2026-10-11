/**
 * A delivery that reaches a running turn lands at that turn's next step, as its signal did, and opens no turn of its
 * own: a drained batch tells the live turn to act on its events before it finishes, never that they arrived while it
 * was idle, and the live turn's end answers the batch as the batch's own turn would have.
 */
import { expect, test } from 'bun:test';
import { jsonSchema, tool } from 'ai';
import { present, scriptedTurnModel, type ScriptedTurnResult } from '@kinu.run/test-utils';
import { pendingEventsDelivery } from '../src/subordinates/deliveries';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import { sessionFixture } from './helpers-session';

const USAGE: ScriptedTurnResult['usage'] = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined },
};

test('an ACTIVE turn absorbs the batch mid-turn — no new turn is enqueued', async () => {
  const watching = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const prompts: string[] = [];

  const model = scriptedTurnModel({ doGenerate: (options): ScriptedTurnResult => {
    prompts.push(JSON.stringify(options.prompt));

    return prompts.length === 1
      ? { content: [{ type: 'tool-call', toolName: 'watch', toolCallId: 'call-watch', input: '{}' }], finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE, warnings: [] }
      : { content: [{ type: 'text', text: 'Deployed; the webhook is handled.' }], finishReason: { unified: 'stop', raw: undefined }, usage: USAGE, warnings: [] };
  } });

  const tools = {
    watch: tool({
      description: 'Watch the deploy', inputSchema: jsonSchema({ type: 'object' }),
      execute: async () => {
        watching.resolve();
        await released.promise;

        return { ok: true };
      },
    }),
  };

  const fixture = await sessionFixture({ model, tools });

  try {
    const sent = fixture.chat.send('Watch the deploy.', { id: 'q-1' });

    await watching.promise;
    fixture.eventLog.publish({
      descriptor: {
        ingress: 'webhook_hmac', variant: 'webhook', auth_outcome: 'verified', webhook_id: 'w1',
        payload: { webhook_id: 'w1', http_method: 'POST', http_headers: {}, body: { x: 1 }, delivery_id: 'd1' },
      },
      now: 1,
    });
    const batch = present(pendingEventsDelivery(fixture.eventLog, Date.now()), 'the drained batch');

    expect(await fixture.chat.admitDelivery(batch)).toBe('taken');
    released.resolve();
    expect(await sent).toBe('turn');
    expect(await fixture.chat.awaitSend('q-1')).toMatchObject({ status: 'settled' });

    // The live turn's next step read the batch, worded for a turn that is working.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('arrived while you were working');
    expect(prompts[1]).not.toContain('arrived while you were idle');
    // No turn of its own: the conversation is the owner's message and its one answer.
    expect((await fixture.actor.stores.history.transcript(CHAT_SESSION_ID).history()).map((entry) => entry.role)).toEqual(['user', 'assistant']);
    // The live turn's end answered the batch: its events stay bound to the batch's turn, their lease closed.
    expect(fixture.actor.runtime.storage.sql<{ consumed_at: number | null }>`
      SELECT consumed_at FROM agent_log WHERE turn_id = ${batch.id} AND kind = 'event'`).toEqual([{ consumed_at: null }]);
  } finally { fixture.close(); }
});
