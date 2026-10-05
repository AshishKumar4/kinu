/**
 * A screenshot the attachment rung moved out of context is a link the agent's file tool opens again, on the cloud's
 * planes. The CLI's twin is in cli-backend's cwd-plane test.
 */
import { expect, test } from 'bun:test';
import { buildBuiltinTools, type JsonValue } from '@kinu.run/core';
import { present, toolExecute } from '@kinu.run/test-utils';
import { compactedScreenshots, screenshot } from '../../compaction/tests/helpers';
import { conversationsFor } from '../../core/tests/helpers';
import { hostedMainActor, orchestratorHarness } from './helpers/actor-harness';

test('the file tool shows the agent a screenshot the rung moved out, from the link it left', async () => {
  const rt = (await hostedMainActor(orchestratorHarness())).actor.runtime;
  const { links } = await compactedScreenshots(rt);
  const file = present(buildBuiltinTools({ rt, conversations: conversationsFor(rt) }).file, 'the file tool');
  const read = await toolExecute<JsonValue, JsonValue>(file)({ action: 'read', path: links[0] ?? '' });

  expect(await present(file.toModelOutput, 'the image output')({ toolCallId: 'reopen', input: {}, output: read })).toEqual({
    type: 'content',
    value: [{ type: 'text', text: `${links[0]}: image/png 1280x800, 40000 bytes` }, { type: 'file', data: { type: 'data', data: screenshot(0) }, mediaType: 'image/png' }],
  });
});
