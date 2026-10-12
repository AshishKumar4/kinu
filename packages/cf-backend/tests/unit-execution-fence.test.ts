/**
 * An agent's runs and chat turns are one sequence of executions behind one fence (design v2 §2-§3, D2): a run opens the
 * fence as it is prepared, under the epoch its claim was minted with, as a chat turn opens it. A chat turn queued behind
 * a run neither takes the fence while the run holds it nor clears the run's opening; once it opened, the run's late call
 * runs nothing and its late close neither takes nor clears the turn's. Driven as production drives it: the owner's turn starts a search whose node runs in its own isolate, and a
 * turn is delivered to that node's chat. A run behind a chat turn is the agent's chat's to order
 * (core tests/unit-execution-claim.test.ts), and the fence's to judge (core tests/unit-turn-fence.test.ts).
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { TurnFences, type AgentToolAnswer, type FencedRow } from '@kinu.run/core';
import { sqlOver } from '@kinu.run/test-utils';
import { catalogTurn, gatewayWorkspace, type StartedHarness } from './helpers/actor-harness';
import { holdNextRunDelivery } from './helpers/agent-facets';
import { chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';

const ASK = 'Find a way to speed up the parser.';

const CHAT = 'CHAT_ON_NODE: list what is open.';

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

function fenceOf(workspace: StartedHarness, actorId: string): FencedRow {
  const row = new TurnFences(sqlOver(workspace.db)).row(actorId);

  if (row === null) throw new Error(`no execution of ${actorId} ever opened its fence`);

  return row;
}

/** A turn the node asks its workspace to queue for it, delivered to its chat as the workspace's producers deliver one. */
async function chatOnNode(workspace: StartedHarness, actorId: string): Promise<void> {
  const port = await workspace.agent.agentWorkspace(actorId);

  expect(await port.enqueueTurn({ text: CHAT, idempotencyKey: 'chat-on-node' })).toEqual({ status: 'queued' });
}

/** A late call carrying `opening`'s capability, as an execution superseded since would send it. */
async function lateCall(workspace: StartedHarness, actorId: string, opening: FencedRow): Promise<AgentToolAnswer> {
  const port = await workspace.agent.agentWorkspace(actorId);

  return await port.executeTool({
    activity: [], turnId: opening.turnId, runId: opening.runId, epoch: opening.seq, mode: 'build', parentDriven: false,
    callId: `late-${opening.runId}`, name: 'tasks', input: { op: 'add', titles: ['LATE_CALL_TASK'] },
  });
}

function lateTasks(workspace: StartedHarness): number {
  return v.parse(v.object({ n: v.number() }), workspace.db.query("SELECT COUNT(*) AS n FROM agent_tasks WHERE title = 'LATE_CALL_TASK'").get()).n;
}

test("a chat turn behind a run waits without taking its fence, and the run's late calls take or clear nothing of the turn's", async () => {
  const run = held();
  const chat = held();
  const workspace = gatewayWorkspace(searching({ run: run.serve, chat: chat.serve }));
  const heldRun = holdNextRunDelivery();
  const owner = catalogTurn(workspace.agent, ASK);
  const { actorId: node, release } = await heldRun;

  release();
  const runCall = await run.asked.promise;
  const ran = fenceOf(workspace, node);

  // The run opened the node's fence as it was prepared.
  expect(ran.live).toBe(true);

  await chatOnNode(workspace, node);
  expect(fenceOf(workspace, node)).toEqual(ran);

  run.answer.resolve(chatCompletion(runCall, 'Cache the token table.'));
  const chatCall = await chat.asked.promise;
  const chatting = fenceOf(workspace, node);

  // The turn opened only once the run ended, later in the node's sequence.
  expect(chatting.live).toBe(true);
  expect(chatting.turnId).not.toBe(ran.turnId);
  expect(chatting.seq).toBeGreaterThan(ran.seq);

  // The run's late call runs nothing, and its late close neither takes nor clears the turn's opening.
  await expect(lateCall(workspace, node, ran)).rejects.toMatchObject({ code: 'cancelled' });
  expect(lateTasks(workspace)).toBe(0);
  await (await workspace.agent.agentWorkspace(node)).runSettled({ turnId: ran.turnId, runId: ran.runId, epoch: ran.seq });
  expect(fenceOf(workspace, node)).toEqual(chatting);

  chat.answer.resolve(chatCompletion(chatCall, 'Nothing is open.'));
  await owner;
  await workspace.agent.harnessAgentsIdle();

  expect(fenceOf(workspace, node)).toEqual({ ...chatting, live: false });
});
