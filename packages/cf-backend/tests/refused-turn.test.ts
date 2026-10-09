// The final walk on 04a4dd0ab: a turn opencode-go refused (429, its usage limit spent) showed its error live, and after a
// reload the chat held the owner's message with no answer and no error. A refused turn's answer keeps the refusal, in the
// provider's own words, on the row a reload reads.
import './helpers/ui-module-globals';
import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CHAT_SESSION_ID, turnFailure } from '@kinu.run/core';
import { createRecordingLogger, setDiagnosticsSink } from '@kinu.run/core/obs';
import { MessageView } from '../src/components/MessageView';
import { catalogTurn, gatewayWorkspace, historyOver } from './helpers/actor-harness';
import { stubAiBinding } from './helpers/platform-gateway';

test.each([0, 8 * 24 * 3600])('a refused turn keeps the provider words in the reloaded UI and logs (Retry-After %i)', async (retryAfter) => {
  const providerText = 'Go usage limit exceeded';

  const gateway = stubAiBinding(() => Response.json(
    { error: { message: providerText, type: 'rate_limit_error' } },
    { status: 429, headers: { 'retry-after': String(retryAfter) } },
  ));

  const workspace = gatewayWorkspace(gateway);

  const log = createRecordingLogger();
  const restore = setDiagnosticsSink(log);

  try {
    await catalogTurn(workspace.agent, 'plan the quarterly offsite');
  } finally { restore(); }

  const [question, answer] = await historyOver(workspace).transcript(CHAT_SESSION_ID).history();

  expect([question?.role, answer?.role]).toEqual(['user', 'assistant']);
  expect(turnFailure({ metadata: answer?.metadata })).toContain(providerText);

  if (answer === undefined) throw new Error('a refused turn left no durable answer');

  expect(renderToStaticMarkup(createElement(MessageView, { message: answer }))).toContain(providerText);
  expect(log.emitted.filter((line) => line.event === 'provider.request_failed').map((line) => line.fields.detail)).toContainEqual(expect.stringContaining(providerText));
});
