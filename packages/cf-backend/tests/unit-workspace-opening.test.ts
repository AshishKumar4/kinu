/**
 * The read a workspace tab opens with (`getWorkspaceOpening`): the snapshot and the lists its first screen draws, so a
 * second wave of reads no longer follows the snapshot (2026-10-09 on production: six reads, 200-500 ms after the
 * transcript). Each list answers as its own read does, and a list that fails is its own failure, not the opening's.
 */
import { expect, test } from 'bun:test';
import { WORK_TAB_JOBS } from '@kinu.run/core';
import { catalogTurn, gatewayWorkspace } from './helpers/actor-harness';
import { answeringGateway } from './helpers/platform-gateway';

test("the opening carries the snapshot and every list the first screen draws, each as that list's own read answers it", async () => {
  const { agent } = gatewayWorkspace(answeringGateway('Done.'));
  await catalogTurn(agent, 'Say done.');

  const opening = await agent.getWorkspaceOpening();
  const snapshot = await agent.getWorkspaceSnapshot();

  expect(opening).toEqual({
    ...snapshot,
    pendingActions: await agent.listPendingActions(),
    backgroundJobs: await agent.listBackgroundJobs(WORK_TAB_JOBS),
    workspaceWork: await agent.listWorkspaceWork(),
    inspectedWork: await agent.inspectWork(),
    subordinates: { value: await agent.listSubordinates() },
    pendingConsents: { value: await agent.listPendingConsents() },
    workspaceAgents: { value: await agent.listWorkspaceAgents() },
  });
  expect(opening.tabPresence).toEqual(await agent.getWorkspaceTabPresence());
});

test('a list that fails is its own failure: the rest of the opening still lands', async () => {
  const { agent } = gatewayWorkspace(answeringGateway('Done.'));

  Object.defineProperty(agent, 'listPendingConsents', {
    configurable: true,
    value: () => Promise.reject(new Error('the consent store did not answer')),
  });

  const opening = await agent.getWorkspaceOpening();

  expect(opening.pendingConsents).toEqual({ error: expect.stringContaining('the consent store did not answer') });
  expect(opening.subordinates).toEqual({ value: await agent.listSubordinates() });
  expect(opening.status).toEqual(await agent.getAgentStatus());
});
