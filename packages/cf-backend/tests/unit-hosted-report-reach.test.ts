/**
 * `report` answers whoever hired the agent, so only a turn its hirer drives carries it: the owner's chat with an added
 * agent offers it neither as a native tool nor as `report` in eval, and a task delegated to the same agent offers both.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { actorConnectionTag } from '@kinu.run/core';
import { asPane } from './helpers/agents-sdk';
import { driveUntil, gatewayWorkspace, runDelegatedTask } from './helpers/actor-harness';
import { chatCompletion, stubAiBinding, type RecordedGatewayRun } from './helpers/platform-gateway';

const OfferedSchema = v.looseObject({
  messages: v.optional(v.array(v.unknown())),
  tools: v.optional(v.array(v.looseObject({ function: v.looseObject({ name: v.string(), description: v.optional(v.string()) }) }))),
});

/** The report a request offered the agent: as a native tool, and in eval's program surface. */
function reportOffered(run: RecordedGatewayRun) {
  const tools = v.parse(OfferedSchema, run.query).tools ?? [];
  const program = tools.find((tool) => tool.function.name === 'eval')?.function.description ?? '';

  return { native: tools.some((tool) => tool.function.name === 'report'), program: program.includes('declare const report') };
}

/** The tool-bearing request that carried `words`. */
function askedWith(runs: readonly RecordedGatewayRun[], words: string): RecordedGatewayRun | undefined {
  return runs.find((run) => {
    const request = v.parse(OfferedSchema, run.query);

    return (request.tools ?? []).length > 0 && JSON.stringify(request.messages ?? []).includes(words);
  });
}

test("the owner's chat with an added agent offers no report, natively or in eval; a task delegated to it offers both", async () => {
  const gateway = stubAiBinding((run) => chatCompletion(run, 'Done.'));
  const workspace = gatewayWorkspace(gateway);

  await workspace.agent.setSoul('# Purpose\n\nAnswer whoever asks.');
  const { subordinate } = await workspace.agent.createSubordinateAgent();
  const actorId = v.parse(v.string(), subordinate.actorId);

  await asPane([actorConnectionTag(actorId)], () => workspace.agent.send('Owner here: how are you?', crypto.randomUUID()));
  await driveUntil(workspace, "the owner's chat never asked the model", () => askedWith(gateway.runs, 'Owner here') !== undefined);
  await runDelegatedTask(workspace, actorId, 'Delegated: summarize the notes.');
  await driveUntil(workspace, 'the delegated task never asked the model', () => askedWith(gateway.runs, 'Delegated:') !== undefined);

  const offered = (words: string) => {
    const run = askedWith(gateway.runs, words);

    return run === undefined ? null : reportOffered(run);
  };

  expect({ owner: offered('Owner here'), delegated: offered('Delegated:') }).toEqual({
    owner: { native: false, program: false },
    delegated: { native: true, program: true },
  });
});
