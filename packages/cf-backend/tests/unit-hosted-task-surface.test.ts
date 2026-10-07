/**
 * A hired subordinate gets the full-agent surface via `buildActorTools`, and its `memory` and `agents` tools run on its own stores.
 * Defends: delegated turns built from the confined head set. Shape is pinned in tests/conformance.test.ts.
 * Each delegated turn is admitted and run as production runs one; its model is served by the platform gateway.
 */
import { expect, test } from 'bun:test';
import { GATEWAY_CATALOG, actorOver, gatewayWorkspace, hostedSubordinateHarness, runDelegatedTask } from './helpers/actor-harness';
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
    { tool: 'memory', args: { op: 'note', content: NOTE } },
    { tool: 'memory', args: { op: 'search', query: 'streaming parser' } },
    { tool: 'agents', args: { op: 'list' } },
  ]);

  const workspace = gatewayWorkspace(gateway);

  const child = await hostedSubordinateHarness(workspace, {
    name: 'surface-prover', displayName: 'Surface prover', nameOrigin: 'user',
    mission: 'prove the delegated surface runs',
  });

  await runDelegatedTask(workspace, child.actor.handle.actorId, 'Save what you know, read it back, and list your roster.');

  const results = toolResults(gateway.runs);
  expect(results).toHaveLength(3);
  expect(results[0]).toContain('Note saved to memory.');
  expect(results[1]).toContain('streaming parser');
  // An empty roster is right for a child that has hired nobody; what matters is that the rung answers.
  expect(results[2]).toContain('subordinates');
});

/** Defends: a delegated turn falling to the runner's default head prompt instead of the agent prompt that names a hire. */
test('a hired subordinate is framed as a hire, not as a head', async () => {
  const gateway = scriptedGateway([]);
  const workspace = gatewayWorkspace(gateway);

  const child = await hostedSubordinateHarness(workspace, {
    name: 'framing-prover', displayName: 'Framing prover', nameOrigin: 'user',
    mission: 'prove the delegated framing',
  });

  await runDelegatedTask(workspace, child.actor.handle.actorId, 'Say what you are.');

  const system = systemPrompt(gateway.runs);
  // The head prompt carries neither the hire's name nor the `report` lane.
  expect(system).toContain('Framing prover');
  expect(system).toContain('report');
});

// The workspace's soul is SOUL.md as it stands: a save with no main turn after it still frames the next hired turn.
test("a hired subordinate's turn is framed with SOUL.md as it stands, not as main last read it", async () => {
  const gateway = scriptedGateway([]);
  const workspace = gatewayWorkspace(gateway);
  await workspace.agent.setSoul('# Checkout\n\n## Mission\n\nAudit the checkout flow.');

  const child = await hostedSubordinateHarness(workspace, {
    name: 'soul-reader', displayName: 'Soul reader', nameOrigin: 'user', mission: 'read the soul it is framed with',
  });

  await runDelegatedTask(workspace, child.actor.handle.actorId, 'Say what the workspace is for.');
  await workspace.agent.setSoul('# Checkout\n\n## Mission\n\nAudit the refunds flow.');
  const before = gateway.runs.length;
  await runDelegatedTask(workspace, child.actor.handle.actorId, 'Say it again.');

  expect(systemPrompt(gateway.runs.slice(before))).toContain('Audit the refunds flow.');
});

test('a hosted child advertises only its callable crafted surface and loses it when code reach is revoked', async () => {
  const gateway = scriptedGateway([]);
  const workspace = gatewayWorkspace(gateway);

  const child = await hostedSubordinateHarness(workspace, {
    name: 'craft-prover', displayName: 'Craft prover', nameOrigin: 'user', mission: 'Inspect your current capabilities.',
  });

  child.actor.runtime.craftStore.create({
    name: 'workspace_echo', description: 'Return the argument', code: '(input) => input',
  });

  await runDelegatedTask(workspace, child.actor.handle.actorId, 'Inspect your available capabilities.');
  const [first] = gateway.runs;

  if (first === undefined) throw new Error('the delegated turn reached no model');
  expect(JSON.stringify(requestOf(first).messages)).toContain('workspace_echo(...args');
  expect(requestOf(first).tools).not.toContain('workspace_echo');

  workspace.agent.harnessInstallCatalog({ ...GATEWAY_CATALOG, roles: {
    reader: { description: 'Files only', instructions: 'Inspect files.', tier: 'default', preset: 'ideate', allowedTools: ['file'] },
  } });
  // An idle hire holds no hosted slot: its settings are its rows.
  actorOver(workspace.db, child.actor.handle.actorId).config.setRoleSelection('reader');
  await runDelegatedTask(workspace, child.actor.handle.actorId, 'Inspect the remaining capabilities.');
  const last = gateway.runs.at(-1);

  if (last === undefined) throw new Error('the second delegated turn reached no model');
  expect(requestOf(last).tools).not.toContain('eval');
  const current = requestOf(last).messages.filter((message) => message.role === 'user').at(-1);
  expect(JSON.stringify(current)).not.toContain('workspace_echo(...args');
});

// Rank 36: a hire's role narrowed its native tools, never the namespaces its eval bound.
test("a hire's eval reaches only the namespaces its role admits", async () => {
  const gateway = scriptedGateway([{ tool: 'eval', args: { code: 'return `${typeof workspace} ${typeof web}`;' } }]);
  const workspace = gatewayWorkspace(gateway);

  const child = await hostedSubordinateHarness(workspace, {
    name: 'reach-prover', displayName: 'Reach prover', nameOrigin: 'user', mission: 'Say what you can reach.',
  });

  workspace.agent.harnessInstallCatalog({ ...GATEWAY_CATALOG, roles: {
    analyst: { description: 'Web only', instructions: 'Answer from the web.', tier: 'default', preset: 'ideate', allowedTools: ['eval', 'web'] },
  } });
  actorOver(workspace.db, child.actor.handle.actorId).config.setRoleSelection('analyst');
  await runDelegatedTask(workspace, child.actor.handle.actorId, 'What can you reach?');

  expect(toolResults(gateway.runs)[0]).toContain('undefined object');
});
