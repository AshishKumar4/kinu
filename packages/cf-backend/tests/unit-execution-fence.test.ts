/**
 * An agent's runs and chat turns are one sequence of executions (design v2 §2-§3, D2). A chat turn queued behind a run
 * waits for the run to answer, then runs; once it runs, the run's late tool call runs nothing and its late close takes
 * nothing of the turn, which goes on to answer. Driven as production drives it: the owner's turn starts a search whose
 * node runs in its own isolate, and the node asks its workspace for a turn of its own while its run is out. A run
 * behind a chat turn is the agent's chat's to order (core tests/unit-execution-claim.test.ts).
 */
import { expect, test } from 'bun:test';
import { TurnFences } from '@kinu.run/core';
import { wrapDatabase } from '@kinu.run/core/identity';
import type { TurnBound } from '../src/agent-facet/agent-turn';
import { catalogTurn, gatewayWorkspace, type StartedHarness } from './helpers/actor-harness';
import { holdNextRunDelivery } from './helpers/agent-facets';
import { chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';

const ASK = 'Find a way to speed up the parser.';

const CHAT = 'CHAT_ON_NODE: list what is open.';

const LATE_TASK = 'LATE_CALL_TASK';

/** The main actor starts a one-node search, then says so; a call carrying `CHAT` is the node's chat, any other its run. */
function searching(answers: { readonly run: (run: RecordedGatewayRun) => Response | Promise<Response>; readonly chat: (run: RecordedGatewayRun) => Response | Promise<Response> }) {
  return stubAiBinding((run) => {
    if (JSON.stringify(requestOf(run).messages).includes(CHAT)) return answers.chat(run);

    if (!openingOf(run).includes(ASK)) return answers.run(run);

    return requestOf(run).messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'Searching.')
      : toolCallCompletion(run, { tool: 'agents', args: { op: 'swarm', task: 'Name one way to tokenize faster.', preset: 'ideate', branches: 1, depth: 1 } }, 'swarm_0');
  });
}

/** A call the model holds until the test answers it. */
function held() {
  const asked = Promise.withResolvers<RecordedGatewayRun>();
  const answer = Promise.withResolvers<Response>();

  const serve = (run: RecordedGatewayRun): Promise<Response> => {
    asked.resolve(run);

    return answer.promise;
  };

  return { asked, answer, serve };
}

/** The capability the running run's calls carry: the opening its preparation made at the workspace. */
function runningCapability(workspace: StartedHarness, actorId: string): TurnBound {
  const opening = new TurnFences(wrapDatabase(workspace.db).sql).row(actorId);

  if (opening === null) throw new Error(`the run of ${actorId} opened nothing`);

  return { turnId: opening.turnId, runId: opening.runId, epoch: opening.seq };
}

/** Every task the owner's work view lists, by title. */
async function listedTasks(workspace: StartedHarness): Promise<string[]> {
  const work = await workspace.agent.listWorkspaceWork();

  return [...work.plans, ...work.tasks].flatMap((owned) => owned.tasks.map((task) => task.title));
}

test("a chat turn behind a run runs once the run answered, and the run's late calls run nothing of it", async () => {
  const run = held();
  const chat = held();
  const workspace = gatewayWorkspace(searching({ run: run.serve, chat: chat.serve }));
  const heldRun = holdNextRunDelivery();
  const owner = catalogTurn(workspace.agent, ASK);
  const { actorId: node, release } = await heldRun;
  const port = await workspace.agent.agentWorkspace(node);

  release();
  const runCall = await run.asked.promise;
  const late = runningCapability(workspace, node);

  // The node asks for a turn of its own while its run is out: it waits behind the run.
  expect(await port.enqueueTurn({ text: CHAT, idempotencyKey: 'chat-on-node' })).toEqual({ status: 'queued' });
  run.answer.resolve(chatCompletion(runCall, 'Cache the token table.'));
  const chatCall = await chat.asked.promise;

  // The run's late tool call is refused and adds no task; its late close changes nothing of the turn now running.
  await expect(port.executeTool({
    activity: [], turnId: late.turnId, runId: late.runId, epoch: late.epoch, mode: 'build', parentDriven: false,
    callId: 'late-call', name: 'tasks', input: { op: 'add', titles: [LATE_TASK] },
  })).rejects.toMatchObject({ code: 'cancelled' });
  await port.runSettled({ turnId: late.turnId, runId: late.runId, epoch: late.epoch });

  chat.answer.resolve(toolCallCompletion(chatCall, { tool: 'tasks', args: { op: 'add', titles: ['CHAT_TASK'] } }, 'chat_task'));
  await owner;
  await workspace.agent.harnessAgentsIdle();

  expect(await listedTasks(workspace)).toEqual(expect.arrayContaining(['CHAT_TASK']));
  expect(await listedTasks(workspace)).not.toContain(LATE_TASK);
});
