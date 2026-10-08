// A swarm a hired agent starts: its workers are that agent's, in what they read and in what the panel opens.
import { expect, test } from 'bun:test';
import { gatewayWorkspace, hostedSubordinateHarness, runDelegatedTask } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

test('a hired agent\'s inheriting swarm starts each worker from that agent\'s conversation', async () => {
  const gateway = stubAiBinding((run) => {
    const request = requestOf(run);

    // The hire's first step starts the swarm; every other call, a worker's included, answers.
    return request.tools.includes('agents') && !request.messages.some((message) => message.role === 'tool')
      ? toolCallCompletion(run, { tool: 'agents', args: {
        op: 'swarm', preset: 'custom', from: 'ideate', label: 'naming', task: 'Name the release.',
        branches: 1, depth: 1, config: { context: 'inherit' },
      } }, 'call_0')
      : chatCompletion(run, 'done');
  });

  const workspace = gatewayWorkspace(gateway);
  const hire = await hostedSubordinateHarness(workspace, { name: 'namer', displayName: 'Namer', nameOrigin: 'user', mission: 'name things' });

  await runDelegatedTask(workspace, hire.actor.handle.actorId, 'The codename is HERON-417. Run a swarm to name the release.');

  const workers = gateway.runs.map(requestOf).filter((request) => !request.tools.includes('agents'));
  expect(workers.length).toBeGreaterThan(0);

  for (const worker of workers) expect(JSON.stringify(worker.messages)).toContain('HERON-417');
});

// Defends: a worker in a hired agent's swarm opening to an empty pane.
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
