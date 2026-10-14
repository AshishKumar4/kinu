/**
 * An added agent's chat is prepared in its isolate once, on its program alone, and kept. Pinned to a model the catalog
 * does not serve, the turn the agent opens fails as it prepares and asks no model; once the owner corrects the pin, the
 * same isolate answers.
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

test("an agent whose bad model pin failed its turn answers once the owner corrects the pin", async () => {
  const gateway = stubAiBinding((run) => chatCompletion(run, 'Hello.'));
  const workspace = gatewayWorkspace(gateway);

  await workspace.agent.setSoul('# Purpose\n\nGreet whoever asks.');
  const { name, subordinate } = await workspace.agent.createSubordinateAgent();
  const actorId = v.parse(v.string(), subordinate.actorId);
  const say = () => asPane([actorConnectionTag(actorId)], () => workspace.agent.send(ASK, crypto.randomUUID()));

  const asking = () => gateway.runs.filter((run) => JSON.stringify(requestOf(run).messages).includes(ASK));

  await workspace.agent.setModel(UNSERVED, name);
  await say();
  await workspace.agent.harnessAgentsIdle();
  expect(asking()).toEqual([]);

  await workspace.agent.setModel(GATEWAY_MODEL, name);
  await say();

  await driveUntil(workspace, 'the agent never asked its model', () => asking().length > 0);
  expect(asking().map(servedByPin)).not.toContain(false);
});
