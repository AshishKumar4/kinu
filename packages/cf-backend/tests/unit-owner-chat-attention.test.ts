/**
 * An agent the owner added waits on them only for work it was given. Their own Stop in its chat asks nothing of them,
 * and their writing to it answers a wait it held. Production, 2026-10-08: one Stop left an owner's chat glowing
 * "needs you" for good.
 */
import { expect, test } from 'bun:test';
import { actorConnectionTag, WORKSPACE_TITLE_SYSTEM_PROMPT } from '@kinu.run/core';
import { asPane, joinHarnessFibers } from './helpers/agents-sdk';
import { agentDatabase } from './helpers/agent-facets';
import { agentSql, driveUntil, gatewayWorkspace, rosterOver, type StartedHarness } from './helpers/actor-harness';
import { chatCompletion, openingOf, requestOf, stubAiBinding, type RecordedGatewayRun } from './helpers/platform-gateway';

/** The owner's message, asked of the agent's model: the agent naming itself after it is not one. */
const asksOf = (run: RecordedGatewayRun, ask: string): boolean => openingOf(run).includes(ask)
  && !JSON.stringify(requestOf(run).messages).includes(WORKSPACE_TITLE_SYSTEM_PROMPT);

/** A model call that answers only once the owner's Stop aborts it. */
const heldUntilStopped = (run: RecordedGatewayRun): Promise<Response> => new Promise((_resolve, reject) => {
  run.signal?.addEventListener('abort', () => { reject(run.signal?.reason); });
});

/** An agent the owner added from the sidebar, as its chat pane names it. */
async function ownersAgent(workspace: StartedHarness) {
  await workspace.agent.setSoul('# Purpose\n\nKeep the parser notes.');
  const { subordinate } = await workspace.agent.createSubordinateAgent();
  const actorId = subordinate.actorId ?? '';

  return { name: subordinate.name, actorId, pane: [actorConnectionTag(actorId)] };
}

/** The agent's turns that have ended, from its own run log. */
const turnsEnded = (actorId: string): number => agentSql(actorId)<{ n: number }>`
  SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${actorId} AND type = 'run_end'`[0]?.n ?? 0;

/** Once the agent's turn has ended and everything it owed (its report to the workspace, its naming) has settled. */
async function settled(workspace: StartedHarness, actorId: string, turns: number): Promise<void> {
  const owed = () => agentDatabase(workspace.agent.agentOf(actorId).storageKey).query<{ n: number }, []>('SELECT COUNT(*) AS n FROM terminal_effects').get()?.n ?? 0;

  await driveUntil(workspace, "the agent's turn never ended", () => turnsEnded(actorId) >= turns);
  await joinHarnessFibers();
  await workspace.agent.harnessAgentsIdle();
  await driveUntil(workspace, "what the agent's turn owed never settled", () => owed() === 0);
}

/** What the owner's sidebar and tab show for the agent. */
async function shown(workspace: StartedHarness, actorId: string): Promise<string | undefined> {
  return (await workspace.agent.listWorkspaceAgents()).find((agent) => agent.actorId === actorId)?.activity;
}

test("the owner's Stop in their own agent's chat leaves that chat asking nothing of them", async () => {
  const ASK = 'Walk the whole grammar.';
  let asked = false;

  const gateway = stubAiBinding((run) => {
    if (!asksOf(run, ASK)) return chatCompletion(run, 'Noted.');
    asked = true;

    return heldUntilStopped(run);
  });

  const workspace = gatewayWorkspace(gateway);
  const agent = await ownersAgent(workspace);

  await asPane(agent.pane, () => workspace.agent.send(ASK, crypto.randomUUID()));
  await driveUntil(workspace, "the agent's model was never asked", () => asked);
  await asPane(agent.pane, () => workspace.agent.cancelCurrentWork());
  await settled(workspace, agent.actorId, 1);

  expect(await shown(workspace, agent.actorId)).toBe('idle');
});

test("an agent waiting on the owner stops waiting once the owner writes to it", async () => {
  const STOPPED = 'Draft the release notes.';
  const NEXT = 'Just list the headings for now.';
  let asked = false;

  const gateway = stubAiBinding((run) => {
    // The next turn's conversation still opens with the stopped ask: it is told apart by what it carries after.
    if (JSON.stringify(requestOf(run).messages).includes(NEXT)) return chatCompletion(run, 'Headings listed.');

    if (!asksOf(run, STOPPED)) return chatCompletion(run, 'Noted.');
    asked = true;

    return heldUntilStopped(run);
  });

  const workspace = gatewayWorkspace(gateway);
  const agent = await ownersAgent(workspace);
  // Work the workspace gave the agent: its Stop leaves that work waiting on the owner.
  rosterOver(workspace.db).assign(agent.name, STOPPED);

  await asPane(agent.pane, () => workspace.agent.send(STOPPED, crypto.randomUUID()));
  await driveUntil(workspace, "the agent's model was never asked", () => asked);
  await asPane(agent.pane, () => workspace.agent.cancelCurrentWork());
  await settled(workspace, agent.actorId, 1);
  const stopped = await shown(workspace, agent.actorId);

  await asPane(agent.pane, () => workspace.agent.send(NEXT, crypto.randomUUID()));
  await settled(workspace, agent.actorId, 2);

  expect({ stopped, answered: await shown(workspace, agent.actorId) }).toEqual({ stopped: 'waiting', answered: 'idle' });
});
