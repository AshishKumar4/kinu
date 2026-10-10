/**
 * Main's answer streams from its own isolate into its room (D9), where the workspace first hears its text. The fleet's
 * first-token latency is read there, once a turn, from the turn's opening.
 */
import { expect, test } from 'bun:test';
import { catalogTurn, gatewayWorkspace } from './helpers/actor-harness';
import { analyticsEngine } from './helpers/analytics-engine';
import { chatCompletion, stubAiBinding } from './helpers/platform-gateway';

test("main's first answer text records its first-token latency on the fleet, once a turn", async () => {
  const engine = analyticsEngine();
  const workspace = gatewayWorkspace(stubAiBinding((run) => chatCompletion(run, 'Noted, the ledger keeps integer cents.')), { analytics: engine.bindings });
  const firstTokens = () => engine.tables.kinu_agent_metrics.filter((row) => Object.values(row).includes('turn.first_token')).length;

  await catalogTurn(workspace.agent, 'Note the ledger.');
  expect(firstTokens()).toBe(1);

  await catalogTurn(workspace.agent, 'And the refunds.');
  expect(firstTokens()).toBe(2);
});
