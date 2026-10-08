/**
 * An agent is named once, from the words it was first given: its brief, or its owner's first message. A turn that
 * opened its chat and did not finish still names it from those words; a later turn's words never do. Production,
 * 2026-10-08: hired and added agents were titled "Continue", after the nudge that followed a first turn cut short.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { actorConnectionTag, WORKSPACE_TITLE_SYSTEM_PROMPT } from '@kinu.run/core';
import { asPane, joinHarnessFibers } from './helpers/agents-sdk';
import { actorOver, agentSql, driveUntil, gatewayWorkspace, ownDatabase } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, type RecordedGatewayRun } from './helpers/platform-gateway';

const said = (run: RecordedGatewayRun): string => JSON.stringify(requestOf(run).messages);

test("an agent whose first turn was stopped is named from its owner's first words, not the next ones", async () => {
  const FIRST = 'Map every lighthouse on the north coast.';
  let asked = false;

  const gateway = stubAiBinding((run) => {
    // The naming model names whatever subject it is given.
    if (said(run).includes(WORKSPACE_TITLE_SYSTEM_PROMPT)) {
      return chatCompletion(run, JSON.stringify({ title: said(run).includes(FIRST) ? 'Coast lights' : 'Carrying on' }));
    }

    if (said(run).includes('"Continue"')) return chatCompletion(run, 'Carrying on.');
    asked = true;

    // The first turn waits until the owner stops it.
    return new Promise<Response>((_resolve, reject) => {
      run.signal?.addEventListener('abort', () => { reject(run.signal?.reason); });
    });
  });

  const workspace = gatewayWorkspace(gateway);
  await workspace.agent.setSoul('# Purpose\n\nKeep the coast notes.');
  const { subordinate } = await workspace.agent.createSubordinateAgent();
  const actorId = v.parse(v.string(), subordinate.actorId);
  const pane = [actorConnectionTag(actorId)];
  const name = () => actorOver(workspace.db, actorId).config.getDisplayName();

  const turnsEnded = (): number => agentSql(workspace, actorId)<{ n: number }>`
    SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ${actorId} AND type = 'run_end'`[0]?.n ?? 0;

  const naming = () => ownDatabase(workspace, actorId)
    .query<{ status: string }, []>(`SELECT status FROM terminal_effects WHERE effect_name = 'auto_title'`).all();

  await asPane(pane, () => workspace.agent.send(FIRST, crypto.randomUUID()));
  await driveUntil(workspace, "the agent's model was never asked", () => asked);
  await asPane(pane, () => workspace.agent.cancelCurrentWork());
  await driveUntil(workspace, "the owner's Stop never ended the first turn", () => turnsEnded() > 0);

  await asPane(pane, () => workspace.agent.send('Continue', crypto.randomUUID()));
  await driveUntil(workspace, 'the nudge was never answered', () => turnsEnded() > 1);
  await joinHarnessFibers();
  await workspace.agent.harnessAgentsIdle();
  await driveUntil(workspace, "the agent's naming never settled", () => naming().length === 0);

  expect(name()).toBe('Coast lights');
});
