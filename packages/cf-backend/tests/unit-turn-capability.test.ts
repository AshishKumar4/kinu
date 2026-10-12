/**
 * A turn's capability and its frozen profile (design v2 §2-§3): every call that runs more of a turn names its run and its
 * opening, which the workspace's durable fence must still hold, and a recovered run assembles on the profile it froze as
 * it first assembled, whatever changed since.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { TurnFences } from '@kinu.run/core';
import { sqlOver } from '@kinu.run/test-utils';
import { catalogTurn, chatSessionTurns, gatewayWorkspace, orchestratorHarness, workspaceMainActor } from './helpers/actor-harness';
import { chatCompletion, stubAiBinding } from './helpers/platform-gateway';

const Count = v.object({ n: v.number() });

test("a call from a run a Retry superseded is refused, though the fence holds the same turn's newer run", async () => {
  const workspace = gatewayWorkspace(stubAiBinding((run) => chatCompletion(run, 'Done.')));

  await catalogTurn(workspace.agent, 'First turn.');
  const actorId = workspaceMainActor(workspace.db).actorId;
  const first = v.parse(v.object({ turn_id: v.string(), run_id: v.string(), seq: v.number() }), workspace.db.query('SELECT turn_id, run_id, seq FROM actor_turn_fence WHERE actor_id = ?').get(actorId));

  // The same turn's Retry opens a new run, as its agent's next opening does.
  expect(new TurnFences(sqlOver(workspace.db)).open(actorId, { turnId: first.turn_id, runId: 'run-retried', seq: first.seq + 1 })).toBe(true);

  const port = await workspace.agent.agentWorkspace(actorId);
  const late = { activity: [], turnId: first.turn_id, runId: first.run_id, epoch: first.seq, mode: 'build' as const, parentDriven: false, callId: 'late-call', name: 'tasks', input: { op: 'add', titles: ['SUPERSEDED_RUN_TASK'] } };

  await expect(port.executeTool(late)).rejects.toMatchObject({ code: 'cancelled' });
  expect(v.parse(Count, workspace.db.query("SELECT COUNT(*) AS n FROM agent_tasks WHERE title = 'SUPERSEDED_RUN_TASK'").get()).n).toBe(0);
});

test('a recovered run assembles on the profile it froze, not on a role chosen since', async () => {
  const { agent } = orchestratorHarness();
  const turns = chatSessionTurns(agent);

  agent.harnessDrivingUserMessage('Inspect the project.', { kinuMode: 'build' });
  const first = await turns.prepare({ messages: [{ role: 'user', content: 'Inspect the project.' }] });

  // Chosen while the run is out: its isolate dies before answering, and the run is recovered on a fresh one.
  await agent.setRole('planner');
  const recovered = await turns.resume();

  expect(recovered.system).toBe(first.system);
  expect(recovered.activeTools).toEqual(first.activeTools);
  await turns.settle({ messageId: 'a-recovered', text: 'Inspected.' });
});
