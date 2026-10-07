/**
 * An added agent's chat is prepared in its isolate once and kept. A preparation that fails is not kept: pinned to a model
 * the catalog does not serve, the agent cannot prepare its chat, and once the owner corrects the pin the same isolate
 * prepares it and answers.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { actorConnectionTag } from '@kinu.run/core';
import { asPane } from './helpers/agents-sdk';
import { driveUntil, gatewayWorkspace } from './helpers/actor-harness';
import { chatCompletion, GATEWAY_MODEL, requestOf, stubAiBinding, type RecordedGatewayRun } from './helpers/platform-gateway';

const UNSERVED = 'ai-gateway/workers-ai/@cf/harness/retired';

const ASK = 'Say hello.';

const ModelSchema = v.looseObject({ model: v.string() });

/** Whether the corrected pin's model served a request. */
const servedByPin = (run: RecordedGatewayRun): boolean => GATEWAY_MODEL.endsWith(v.parse(ModelSchema, run.query).model);

test("an agent a bad model pin kept from preparing its chat answers once the owner corrects the pin", async () => {
  const gateway = stubAiBinding((run) => chatCompletion(run, 'Hello.'));
  const workspace = gatewayWorkspace(gateway);

  await workspace.agent.setSoul('# Purpose\n\nGreet whoever asks.');
  const { name, subordinate } = await workspace.agent.createSubordinateAgent();
  const actorId = v.parse(v.string(), subordinate.actorId);
  const say = () => asPane([actorConnectionTag(actorId)], () => workspace.agent.send(ASK, crypto.randomUUID()));

  await workspace.agent.setActorModel(name, UNSERVED);
  await expect(say()).rejects.toThrow();

  await workspace.agent.setActorModel(name, GATEWAY_MODEL);
  await say();
  const asking = () => gateway.runs.filter((run) => JSON.stringify(requestOf(run).messages).includes(ASK));

  await driveUntil(workspace, 'the agent never asked its model', () => asking().length > 0);
  expect(asking().map(servedByPin)).not.toContain(false);
});
