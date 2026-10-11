/**
 * The workspace keeps main's prompt cache warm between its turns: its lane counts each real request, so a warm armed
 * before one is void, and arms the warm a turn earned. Main's turns run in its own isolate (D9), whose session tells
 * the workspace's lane as each request starts and as each turn ends.
 */
import { expect, test } from 'bun:test';
import { catalogTurn, gatewayWorkspace } from './helpers/actor-harness';
import { chatCompletion, stubAiBinding } from './helpers/platform-gateway';

test("each request of main's turns reaches the workspace's warming lane", async () => {
  const workspace = gatewayWorkspace(stubAiBinding((run) => chatCompletion(run, 'Noted.')));

  await catalogTurn(workspace.agent, 'Note the ledger.');
  await catalogTurn(workspace.agent, 'And the refunds.');

  expect(workspace.db.query('SELECT requests FROM cache_warm').all()).toEqual([{ requests: 2 }]);
});
