// The final walk on 04a4dd0ab: a turn opencode-go refused (429, its usage limit spent) showed its error live, and after a
// reload the chat held the owner's message with no answer and no error. A refused turn's answer keeps the refusal, in the
// provider's own words, on the row a reload reads.
import { expect, test } from 'bun:test';
import { CHAT_SESSION_ID, turnFailure } from '@kinu.run/core';
import { catalogTurn, gatewayWorkspace, historyOver } from './helpers/actor-harness';
import { stubAiBinding } from './helpers/platform-gateway';

test('a turn the provider refuses records the refusal, in its words, on the answer a reload reads', async () => {
  const gateway = stubAiBinding(() => Response.json(
    { error: { message: 'Go usage limit exceeded', type: 'rate_limit_error' } },
    { status: 429, headers: { 'retry-after': String(8 * 24 * 3600) } },
  ));

  const workspace = gatewayWorkspace(gateway);

  await catalogTurn(workspace.agent, 'plan the quarterly offsite');
  const [question, answer] = await historyOver(workspace).transcript(CHAT_SESSION_ID).history();

  expect([question?.role, answer?.role]).toEqual(['user', 'assistant']);
  expect(turnFailure({ metadata: answer?.metadata })).toContain('Go usage limit exceeded');
});
