/**
 * A device call with no binding parks NOT RUN on the owner, and the owner's answer reaches the agent that asked as the
 * turn its wake opens, through the agent's own delivery queue: the only way that agent learns it may re-issue.
 */
import { expect, test } from 'bun:test';
import { catalogTurn, driveUntil, gatewayWorkspace, workspaceMainActor } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding } from './helpers/platform-gateway';

test("the owner's answer opens a turn of the agent that asked, telling it to re-issue its call once", async () => {
  const asked: string[] = [];

  const gateway = stubAiBinding((run) => {
    asked.push(JSON.stringify(requestOf(run).messages));

    return chatCompletion(run, 'Noted.');
  });

  const workspace = gatewayWorkspace(gateway);
  await catalogTurn(workspace.agent, 'Start the ledger.');
  const main = workspaceMainActor(workspace.db).actorId;

  expect(await workspace.agent.askDeviceConsent({
    deviceId: 'dev-1', deviceLabel: 'the laptop', method: 'exec', command: 'make deploy', actorId: main, epoch: 0,
  })).toBe('queued');

  const [card] = await workspace.agent.listPendingConsents();

  expect(await workspace.agent.resolveDeviceConsent(card?.consentId ?? '', 'once')).toEqual({ ok: true });

  const woke = () => asked.some((messages) => messages.includes('Device use APPROVED, still not run: re-issue once') && messages.includes('make deploy'));

  await driveUntil(workspace, "the owner's answer never opened the asking agent's turn", woke);
  expect(await workspace.agent.askDeviceConsent({
    deviceId: 'dev-1', deviceLabel: 'the laptop', method: 'exec', command: 'make deploy', actorId: main, epoch: 0,
  })).toBe('once');
});
