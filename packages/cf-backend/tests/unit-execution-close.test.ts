/**
 * A close (an execution's trace, charges, answer metadata, end or settle) names the execution it closes, by its turn,
 * its run and the epoch its claim opened with (design v2 §3). The workspace judges it against the openings it admitted:
 * an execution's own close runs after a newer opening, and one naming an opening as another execution's, or an opening
 * newer than any admitted, is refused before anything runs.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { agentSql, catalogTurn, gatewayWorkspace, workspaceMainActor } from './helpers/actor-harness';
import { chatCompletion, stubAiBinding } from './helpers/platform-gateway';

const Claim = v.object({ turn_id: v.string(), run_id: v.string(), epoch: v.number() });

test("a close naming another execution's opening runs nothing, and an execution's own close runs after newer ones", async () => {
  const workspace = gatewayWorkspace(stubAiBinding((run) => chatCompletion(run, 'Done.')));

  await catalogTurn(workspace.agent, 'First.');
  await catalogTurn(workspace.agent, 'Second.');
  const main = workspaceMainActor(workspace.db).actorId;
  const claims = agentSql(workspace, main)`SELECT turn_id, run_id, epoch FROM actor_turn_claims ORDER BY claimed_at`;
  const [first, second] = v.parse(v.tuple([Claim, Claim]), claims);
  const port = await workspace.agent.agentWorkspace(main);

  // The first's opening, claimed by the second's run.
  await expect(port.runSettled({ turnId: first.turn_id, runId: second.run_id, epoch: first.epoch })).rejects.toMatchObject({ code: 'denied' });
  // An opening newer than any the agent made.
  await expect(port.runSettled({ turnId: 'turn-never', runId: 'run-never', epoch: second.epoch + 10 })).rejects.toMatchObject({ code: 'denied' });
  // The first's own close, after the second opened.
  await expect(port.runSettled({ turnId: first.turn_id, runId: first.run_id, epoch: first.epoch })).resolves.toBeUndefined();
});
