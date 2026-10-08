// A turn that fails before its answer row exists records the failure on an answer of its own, through the same row a
// settled turn writes, so a reload shows why the owner's message has no answer.
import { expect, test } from 'bun:test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { KinuError } from '../src/obs/error';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import { turnFailure } from '../src/read-models/background-event';
import { sessionFixture } from './helpers-session';

const model = scriptedTurnModel({ doGenerate: async () => ({
  content: [{ type: 'text', text: 'planned' }],
  finishReason: { unified: 'stop', raw: undefined },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
  warnings: [],
}) });

test.each([
  {
    stage: 'its preparation', cause: 'the profile catalog could not be read',
    ports: { prepareTurn: async () => { throw new KinuError('unavailable', 'the profile catalog could not be read'); } },
  },
  {
    stage: 'the commit of its answer', cause: 'the roster could not be frozen',
    ports: { owedTerminalEffects: () => { throw new KinuError('io', 'the roster could not be frozen'); } },
  },
])('a turn that fails in $stage records the failure on an answer a reload reads', async ({ cause, ports }) => {
  const fixture = await sessionFixture({ model, ports });

  try {
    await fixture.chat.send('plan the quarterly offsite', { id: 'q-1' });
    const [question, answer, ...after] = await fixture.actor.stores.history.transcript(CHAT_SESSION_ID).history();

    expect([question?.id, answer?.role, answer?.parts, after]).toEqual(['q-1', 'assistant', [], []]);
    expect(turnFailure({ metadata: answer?.metadata })).toContain(cause);
  } finally { fixture.close(); }
});
