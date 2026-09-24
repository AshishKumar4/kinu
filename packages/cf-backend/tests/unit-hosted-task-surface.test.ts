/**
 * A hired subordinate gets the full-agent surface via `buildActorTools`, and its `memory` and `agents` tools run on its own stores.
 * Defends: delegated turns built from the confined head set. Shape is pinned in tests/conformance.test.ts.
 * Each delegated turn is admitted and run as production runs one; its model is served by the platform gateway.
 */
import { expect, test } from 'bun:test';
import { GATEWAY_CATALOG, gatewayWorkspace, hostedSubordinateHarness, runDelegatedTask } from './helpers/actor-harness';
import { requestOf, scriptedGateway, type RecordedGatewayRun } from './helpers/platform-gateway';

const NOTE = 'the streaming parser holds no whole file';

/** What each tool call answered, in call order, as the model read it back. */
function toolResults(runs: readonly RecordedGatewayRun[]): string[] {
  const last = runs.at(-1);

  if (last === undefined) throw new Error('the delegated turn reached no model');

  return requestOf(last).messages.filter((message) => message.role === 'tool').map((message) => JSON.stringify(message.content));
}

function systemPrompt(runs: readonly RecordedGatewayRun[]): string {
  for (const run of runs) {
    const system = requestOf(run).messages.find((message) => message.role === 'system');

    if (system !== undefined) return JSON.stringify(system.content);
  }

  throw new Error('the turn issued no request carrying a system prompt');
}

test('a hired subordinate saves and searches memory and lists its roster in its assigned turn', async () => {
  const gateway = scriptedGateway([
    { tool: 'memory', args: { action: 'save', content: NOTE } },
    { tool: 'memory', args: { action: 'search', query: 'streaming parser' } },
    { tool: 'agents', args: { action: 'list' } },
  ]);

  const workspace = gatewayWorkspace(gateway);

  const child = await hostedSubordinateHarness(workspace, {
    name: 'surface-prover', displayName: 'Surface prover', nameOrigin: 'user',
    mission: 'prove the delegated surface runs',
  });

  await runDelegatedTask(workspace, child.actor, 'Save what you know, read it back, and list your roster.');

  const results = toolResults(gateway.runs);
  expect(results).toHaveLength(3);
  expect(results[0]).toContain('Note saved to memory.');
  expect(results[1]).toContain('streaming parser');
  // An empty roster is right for a child that has hired nobody; what matters is that the rung answers.
  expect(results[2]).toContain('subordinates');
});

/** Defends: `runHostedTask` falling to the runner's default head prompt instead of the agent prompt that names a hire. */
test('a hired subordinate is framed as a hire, not as a head', async () => {
  const gateway = scriptedGateway([]);
  const workspace = gatewayWorkspace(gateway);

  const child = await hostedSubordinateHarness(workspace, {
    name: 'framing-prover', displayName: 'Framing prover', nameOrigin: 'user',
    mission: 'prove the delegated framing',
  });

  await runDelegatedTask(workspace, child.actor, 'Say what you are.');

  const system = systemPrompt(gateway.runs);
  // The head prompt carries neither the hire's name nor the `report` lane.
  expect(system).toContain('Framing prover');
  expect(system).toContain('report');
});

test('a hosted child advertises only its callable crafted surface and loses it when code reach is revoked', async () => {
  const gateway = scriptedGateway([]);
  const workspace = gatewayWorkspace(gateway);

  const child = await hostedSubordinateHarness(workspace, {
    name: 'craft-prover', displayName: 'Craft prover', nameOrigin: 'user', mission: 'Inspect your current capabilities.',
  });

  child.actor.runtime.craftStore.create({
    name: 'workspace_echo', description: 'Return the argument', code: '(input) => input', params: null, scope: 'local',
  });

  await runDelegatedTask(workspace, child.actor, 'Inspect your available capabilities.');
  const [first] = gateway.runs;

  if (first === undefined) throw new Error('the delegated turn reached no model');
  expect(JSON.stringify(requestOf(first).messages)).toContain('workspace_echo(...args');
  expect(requestOf(first).tools).not.toContain('workspace_echo');

  workspace.agent.harnessInstallCatalog({ ...GATEWAY_CATALOG, roles: {
    reader: { description: 'Files only', instructions: 'Inspect files.', tier: 'default', preset: 'ideate', allowedTools: ['file'] },
  } });
  child.actor.stores.config.setRoleSelection('reader');
  await runDelegatedTask(workspace, child.actor, 'Inspect the remaining capabilities.');
  const last = gateway.runs.at(-1);

  if (last === undefined) throw new Error('the second delegated turn reached no model');
  expect(requestOf(last).tools).not.toContain('eval');
  const current = requestOf(last).messages.filter((message) => message.role === 'user').at(-1);
  expect(JSON.stringify(current)).not.toContain('workspace_echo(...args');
});
