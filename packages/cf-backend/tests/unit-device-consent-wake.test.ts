/**
 * A device call with no binding parks NOT RUN on the owner, and the owner's answer reaches the agent that asked as the
 * turn its wake opens, through the agent's own delivery queue: the only way that agent learns it may re-issue. The
 * re-issue is the call the owner's request made, so it runs under the background policy of the turn it was parked
 * from: staging c595a3e6b's device-job-output re-issued a 45 s command in a woken turn's 300 s window, and no job formed.
 */
import { expect, test } from 'bun:test';
import type { InvocationSurface } from '@kinu.run/core';
import { handClock, present } from '@kinu.run/test-utils';
import { catalogTurn, driveUntil, gatewayWorkspace, workspaceMainActor } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';
import { serverBox, SERVING } from './helpers/server-box';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';

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

const APPROVED = 'Device use APPROVED, still not run: re-issue once';

/** What a model call was asked, without the runtime state blocks the turn adds. */
const asked = (run: RecordedGatewayRun): string[] => requestOf(run).messages
  .filter((message) => message.role === 'user' && !JSON.stringify(message.content).includes('<dynamic_context'))
  .map((message) => JSON.stringify(message.content));

/** The answers a model call read back from its tool calls. */
const toolAnswers = (run: RecordedGatewayRun): string[] => requestOf(run).messages
  .filter((message) => message.role === 'tool').map((message) => JSON.stringify(message.content));

/**
 * The main agent's `node server.js`, parked on the owner from a turn of `surface` and answered `once`: what its re-issue,
 * in the turn the answer wakes, was told. The call's window and the server's life (past a chat turn's window, inside a
 * woken turn's) are both on the job clock, and the earlier fires.
 */
async function reissued(surface: InvocationSurface): Promise<string> {
  const clock = handClock(Date.now());

  const gateway = stubAiBinding((run) => {
    if (asked(run).at(-1)?.includes(APPROVED) !== true) return chatCompletion(run, 'Noted.');

    return toolAnswers(run).length === 0
      ? toolCallCompletion(run, { tool: 'shell', args: { command: 'node server.js', runtime: 'computer' } }, 'call_server')
      : chatCompletion(run, 'Re-issued.');
  });

  const box = serverBox(clock);
  const workspace = gatewayWorkspace(gateway, { container: true, box: () => box, jobClock: clock, previewHostSuffix: 'preview.test' });
  // The owner's egress vault is read before a sandbox command runs.
  workspace.agent.harnessDeclareEnv({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
  await catalogTurn(workspace.agent, 'Start the ledger.');
  const main = workspaceMainActor(workspace.db).actorId;

  await workspace.agent.askDeviceConsent({
    deviceId: 'dev-1', deviceLabel: 'the laptop', method: 'exec', command: 'node server.js', actorId: main, epoch: 0, surface,
  });
  const [card] = await workspace.agent.listPendingConsents();

  expect(clock.armed()).toBe(0);
  await workspace.agent.resolveDeviceConsent(card?.consentId ?? '', 'once');
  await driveUntil(workspace, "the answer's turn never re-issued the call", () => clock.armed() >= 2);
  clock.tick();

  const answered = () => gateway.runs.find((run) => toolAnswers(run).length > 0);
  await driveUntil(workspace, "the re-issue's answer never reached the model", () => answered() !== undefined);

  return toolAnswers(present(answered(), 'the answered run')).join('');
}

test("a call parked from a chat turn is re-issued on that turn's window: a command that outruns it becomes a job", async () => {
  expect(await reissued('interactive')).toContain('backgrounded');
});

test("one parked from a turn an event opened keeps that turn's longer window: the command ends in the foreground", async () => {
  const told = await reissued('one-shot');

  expect(told).not.toContain('backgrounded');
  expect(told).toContain(SERVING.trim());
});
