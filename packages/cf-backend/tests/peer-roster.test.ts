// The `agents` tool's team list names the account's other workspaces as peers, never the one asking.
import { expect, test } from 'bun:test';
import { catalogTurn, GATEWAY_CATALOG, orchestratorHarness, type RecordedUserPlaneCalls } from './helpers/actor-harness';
import { requestOf, scriptedGateway } from './helpers/platform-gateway';

test('a workspace listing its team sees the account\'s other workspaces and not itself', async () => {
  const gateway = scriptedGateway([{ tool: 'agents', args: { action: 'list' } }]);

  const userPlane: RecordedUserPlaneCalls = {
    warmConnections: [], failWarm: null, titles: [],
    workspaces: [{ name: 'harness-parent', displayName: 'Jarvis' }, { name: 'scout-a1b2c3', displayName: 'Scout' }],
  };

  const { agent } = orchestratorHarness(userPlane, { aiGateway: gateway });

  agent.harnessInstallCatalog(GATEWAY_CATALOG);
  await catalogTurn(agent, 'who is on my team?');

  const last = gateway.runs.at(-1);
  const listed = last === undefined ? '' : JSON.stringify(requestOf(last).messages.filter((message) => message.role === 'tool'));

  expect({ scout: listed.includes('scout-a1b2c3'), self: listed.includes('harness-parent') }).toEqual({ scout: true, self: false });
});
