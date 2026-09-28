// A swarm worker opened from the Agents panel: its transcript is read from the journal of the agent that started
// the swarm. Defends: a worker in a hired agent's swarm opening to an empty pane.
import { expect, test } from 'bun:test';
import { gatewayWorkspace } from './helpers/actor-harness';
import { chatCompletion, stubAiBinding } from './helpers/platform-gateway';

test('a worker in a hired agent\'s swarm reads that agent\'s journal', async () => {
  const workspace = gatewayWorkspace(stubAiBinding((run) => chatCompletion(run, 'ok')));
  await workspace.agent.setSoul('# Purpose\n\nShip the coupon fix.');
  const { subordinate } = await workspace.agent.createSubordinateAgent();

  if (subordinate.actorId === null) throw new Error('the hired agent has no actor');

  workspace.db.query('INSERT INTO head_runs (actor_id, root_id, rationale, spawned_at) VALUES (?, ?, ?, ?)').run(subordinate.actorId, 'run-1', 'compare parsers', 1);
  workspace.db.query(`INSERT INTO head_journal (actor_id, id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
    VALUES (?, 'h-a', NULL, 'run-1', 0, 'Try the PEG parser', 'r', 'running', 2, 'synthesize')`).run(subordinate.actorId);

  expect(await workspace.agent.getNodeTranscript('run-1', 'h-a')).toBeNull();
  expect((await workspace.agent.getNodeTranscript('run-1', 'h-a', {}, subordinate.name))?.task).toBe('Try the PEG parser');
});
