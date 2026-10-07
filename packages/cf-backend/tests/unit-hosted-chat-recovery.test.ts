/**
 * An added agent's chat runs in its own isolate, and the workspace that hosts it may reset under it. What the agent was
 * asked is not lost to that: the workspace keeps the wake the agent's isolate cannot set itself, the agent's chat takes
 * its turn up again, and the owner's Stop reaches the turn whatever the new workspace has heard of it. A task whose
 * turn cannot even be prepared is answered to its hirer as blocked, never left looking done.
 */
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { actorConnectionTag, RECOVERY_BACKOFF_CEILING_MS, WORKSPACE_TITLE_SYSTEM_PROMPT } from '@kinu.run/core';
import { abandonHarnessFibers, asPane } from './helpers/agents-sdk';
import {
  actorOver, driveUntil, gatewayWorkspace, GATEWAY_CATALOG, reactivateOrchestratorHarness, rosterOver, until, wakeForDelegatedTask,
  type StartedHarness,
} from './helpers/actor-harness';
import { chatCompletion, openingOf, requestOf, stubAiBinding, type RecordedGatewayRun, type StubbedAiBinding } from './helpers/platform-gateway';

afterEach(() => { setSystemTime(); });

/** The workspace reset: its isolate's fibers die with it, its storage and the agent's stay. */
async function afterReset(db: StartedHarness['db'], gateway: StubbedAiBinding): Promise<StartedHarness> {
  abandonHarnessFibers();

  return await reactivateOrchestratorHarness(db, undefined, {
    world: { aiGateway: gateway },
    beforeStart: (agent) => { agent.harnessInstallCatalog(GATEWAY_CATALOG); },
  });
}

/** A lap later the agent's wake falls due, and the workspace's alarm delivers it: a facet sets no alarm of its own. */
async function lapLater(workspace: StartedHarness): Promise<void> {
  setSystemTime(new Date(Date.now() + RECOVERY_BACKOFF_CEILING_MS + 1));
  await workspace.agent.alarm();
}

/** The owner's message, asked of the agent's model: the agent naming itself after it is not one. */
const asksOf = (run: RecordedGatewayRun, ask: string): boolean => openingOf(run).includes(ask)
  && !JSON.stringify(requestOf(run).messages).includes(WORKSPACE_TITLE_SYSTEM_PROMPT);

async function addedAgent(workspace: StartedHarness): Promise<readonly string[]> {
  return (await agentAdded(workspace)).pane;
}

/** The added agent's pane, and its id, which names its chat to the owner's reads. */
async function agentAdded(workspace: StartedHarness): Promise<{ readonly pane: readonly string[]; readonly actorId: string }> {
  await workspace.agent.setSoul('# Purpose\n\nKeep the parser notes.');
  const { subordinate } = await workspace.agent.createSubordinateAgent();
  const actorId = subordinate.actorId ?? '';

  return { pane: [actorConnectionTag(actorId)], actorId };
}

test("an owner's message to an agent survives the workspace resetting mid-turn, and is answered", async () => {
  const ASK = 'Note where the parser buffers tokens.';
  const ANSWER = 'Tokens buffer in a lookahead ring.';
  let asked = 0;

  const gateway = stubAiBinding(async (run) => {
    if (!asksOf(run, ASK)) return chatCompletion(run, 'Noted.');
    asked += 1;

    // The first isolate dies with this call open.
    if (asked === 1) return await new Promise<Response>(() => {});

    return chatCompletion(run, ANSWER);
  });

  const first = gatewayWorkspace(gateway);
  const { pane, actorId } = await agentAdded(first);

  await asPane(pane, () => first.agent.send(ASK, crypto.randomUUID()));
  await driveUntil(first, "the agent's model was never asked", () => asked === 1);

  const second = await afterReset(first.db, gateway);

  await lapLater(second);
  await until(() => asked === 2 && second.agent.harnessTurnsInFlight() === 0, 'the agent never finished its turn after the reset');

  // The answer is the one the agent's chat keeps, as the owner reads it: once, after the ask it answers.
  const chat = JSON.stringify((await second.agent.getChatHistoryPage({ actor: actorId, limit: 20 })).items);

  expect(chat.split(ANSWER).length - 1).toBe(1);
  expect(chat.indexOf(ASK)).toBeLessThan(chat.indexOf(ANSWER));
});

test("the owner's Stop reaches an agent's turn that a reset workspace never saw begin", async () => {
  const ASK = 'Walk the whole grammar.';
  let asked = 0;
  let stopped = false;

  const gateway = stubAiBinding(async (run) => {
    if (!asksOf(run, ASK)) return chatCompletion(run, 'Noted.');
    asked += 1;

    return await new Promise<Response>((_resolve, reject) => {
      // Only the second run can be stopped: the first isolate died with its call open.
      if (asked === 1) return;
      run.signal?.addEventListener('abort', () => {
        stopped = true;
        reject(run.signal?.reason);
      });
    });
  });

  const first = gatewayWorkspace(gateway);
  const pane = await addedAgent(first);

  await asPane(pane, () => first.agent.send(ASK, crypto.randomUUID()));
  await driveUntil(first, "the agent's model was never asked", () => asked === 1);

  const second = await afterReset(first.db, gateway);

  await lapLater(second);
  await until(() => asked === 2, 'the agent never took its turn up again');
  await asPane(pane, () => second.agent.cancelCurrentWork());
  await until(() => stopped, "the owner's Stop never reached the agent's turn");
});

test("a delegated task whose turn cannot be prepared is answered to its hirer as blocked", async () => {
  const FIRST = 'Draft the first notes.';
  const SECOND = 'Draft the second notes.';
  const gateway = stubAiBinding((run) => chatCompletion(run, 'Done.'));
  const workspace = gatewayWorkspace(gateway);

  const child = await workspace.agent.actorDirectory({
    action: 'register', creationId: 'unpreparable-proof', name: 'drafter', origin: 'agent', lifetime: 'durable',
  });

  rosterOver(workspace.db).create({
    name: 'drafter', actorReference: child.reference, birth: null, deleteRequested: false,
    status: 'working', currentTask: FIRST, createdAt: Date.now(), dismissedAt: null, taskEventId: null,
  });

  const openings = () => gateway.runs.map(openingOf);

  await wakeForDelegatedTask(workspace, child.reference.actorId, FIRST);
  await driveUntil(workspace, 'the first task never ran', () => openings().some((text) => text.includes(FIRST)));

  // Its isolate is up. The second task's turn opens there, and its profile then pins a model its provider does not list.
  actorOver(workspace.db, child.reference.actorId).config.setModel('workers-ai/@cf/kinu-probe-does-not-exist');
  rosterOver(workspace.db).assign('drafter', SECOND);
  await wakeForDelegatedTask(workspace, child.reference.actorId, SECOND);

  // The hirer's later turns open on its first report, so the second is read from the whole request.
  const told = () => gateway.runs.map((run) => JSON.stringify(requestOf(run).messages))
    .filter((text) => text.includes('[subordinate_report]') && text.includes('failed to run its assigned turn'));

  await driveUntil(workspace, 'the hirer was never told the second task could not run', () => told().length > 0);
  // The report names what refused the turn: the pinned model its provider does not list.
  expect(told().join(' ')).toContain('kinu-probe-does-not-exist');
  expect(openings().filter((text) => text.includes(SECOND) && !text.includes('[subordinate_report]'))).toEqual([]);
});
