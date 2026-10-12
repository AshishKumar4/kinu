/**
 * The cuts between a workspace's commit and what it projects from it: a delivery committed with its wake whose alarm a
 * reset kept from being set, and a Stop committed in the workspace that a reset kept from reaching the agent's isolate.
 * Each is carried across the reset by a row its commit wrote, and the next activation finishes it.
 */
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { actorConnectionTag } from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import { asPane } from './helpers/agents-sdk';
import { catalogTurn, fireAlarm, gatewayWorkspace, GATEWAY_CATALOG, reactivateOrchestratorHarness, until, workspaceMainActor, type StartedHarness } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, type StubbedAiBinding } from './helpers/platform-gateway';

afterEach(() => { setSystemTime(); });

const Count = v.object({ n: v.number() });

/** The next activation over the same rows, as after a reset: its own alarm, none set yet. */
async function afterReset(workspace: StartedHarness, gateway: StubbedAiBinding): Promise<StartedHarness> {
  const next = await reactivateOrchestratorHarness(workspace.db, undefined, {
    world: { aiGateway: gateway },
    beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
  });

  await next.started;

  return next;
}

/** Every model request's messages, as the gateway saw them. */
function recordingGateway(answer: (prompt: string) => Response | Promise<Response> | null = () => null) {
  const asked: string[] = [];

  const gateway = stubAiBinding((run) => {
    const prompt = JSON.stringify(requestOf(run).messages);

    asked.push(prompt);

    return answer(prompt) ?? chatCompletion(run, 'Done.');
  });

  return { gateway, asked };
}

test("a delivery committed with its wake, whose alarm a reset kept from being set, crosses at the workspace's next start", async () => {
  const { gateway, asked } = recordingGateway();
  const workspace = gatewayWorkspace(gateway);

  await workspace.agent.setSoul('# Purpose\n\nGreet whoever asks.');
  const { subordinate } = await workspace.agent.createSubordinateAgent();
  const actorId = v.parse(v.string(), subordinate.actorId);

  // The owner's words commit with their wake, and their crossing does not reach the agent's isolate.
  workspace.agent.harnessIsolateRefusal = { refuses: (id) => id === actorId, error: new KinuError('unavailable', 'the isolate is unreachable') };
  await expect(asPane([actorConnectionTag(actorId)], () => workspace.agent.send('OWED_WORDS_MARKER', crypto.randomUUID()))).rejects.toThrow();
  expect(v.parse(Count, workspace.db.query('SELECT COUNT(*) AS n FROM agent_deliveries WHERE actor_id = ?').get(actorId)).n).toBe(1);

  // The workspace resets before its alarm is set: the next activation sets one from what is owed, and that alarm alone
  // brings the words to the agent.
  const restarted = await afterReset(workspace, gateway);

  await fireAlarm(restarted.agent);
  await until(() => asked.some((prompt) => prompt.includes('OWED_WORDS_MARKER')), 'the owed words never reached the agent');
  expect(v.parse(Count, restarted.db.query('SELECT COUNT(*) AS n FROM agent_deliveries').get()).n).toBe(0);
});

test("a Stop the workspace reset before main's isolate took it cancels what that isolate queued, before anything else runs", async () => {
  // The task running when the workspace resets parks at its model there; an activation after the reset answers it.
  const parked = Promise.withResolvers<Response>();
  let resetting = true;
  const { gateway, asked } = recordingGateway((prompt) => (resetting && prompt.includes('RUNNING_MARKER') ? parked.promise : null));
  const workspace = gatewayWorkspace(gateway);

  await catalogTurn(workspace.agent, 'Start the ledger.');
  const main = workspaceMainActor(workspace.db).actorId;
  const owed = () => v.parse(Count, workspace.db.query('SELECT COUNT(*) AS n FROM agent_deliveries').get()).n;

  // A task runs in main's isolate, and another is taken there behind it: paid, its outbox row gone.
  expect(await workspace.agent.runTaskFromMcp('RUNNING_MARKER')).toEqual({ status: 'queued' });
  await until(() => asked.some((prompt) => prompt.includes('RUNNING_MARKER')), 'the running task never reached its model');
  expect(await workspace.agent.runTaskFromMcp('QUEUED_MARKER')).toEqual({ status: 'queued' });
  await until(() => owed() === 0, "the queued task never reached main's isolate");

  // The Stop commits in the workspace, and the workspace resets before main's isolate takes it.
  workspace.agent.harnessIsolateRefusal = { refuses: (id) => id === main, error: new KinuError('unavailable', 'the workspace reset') };
  await expect(workspace.agent.cancelCurrentWork()).rejects.toThrow('the workspace reset');

  resetting = false;
  const restarted = await afterReset(workspace, gateway);

  // The owner's next words run; the task queued before the Stop never does.
  await catalogTurn(restarted.agent, 'AFTER_STOP_MARKER');
  await restarted.agent.harnessAgentsIdle();

  expect({ after: asked.some((prompt) => prompt.includes('AFTER_STOP_MARKER')), queued: asked.some((prompt) => prompt.includes('QUEUED_MARKER')) })
    .toEqual({ after: true, queued: false });
  // The Stop is answered: its isolate took it after the reset, and nothing of it is owed now.
  expect(restarted.db.query('SELECT generation, retired FROM agent_stops WHERE actor_id = ?').all(main)).toEqual([{ generation: 1, retired: 1 }]);
});
