import { describe, expect, test } from 'bun:test';
import { openWorkspaceMainActor, TaskListStore } from '@kinu.run/core';
import { sqlOver } from '@kinu.run/test-utils';
import { orchestratorHarness } from './helpers/actor-harness';

describe('the snapshot a reconnecting pane consumes', () => {
  test('a fresh workspace hides empty work, then reports a persisted task', async () => {
    const workspace = orchestratorHarness();
    await workspace.started;

    expect((await workspace.agent.getWorkspaceSnapshot()).tabPresence)
      .toEqual({ work: false, explorations: false });

    const sql = sqlOver(workspace.db);
    const tasks = new TaskListStore(sql, openWorkspaceMainActor(sql), (write) => write());
    tasks.add(['repair the checkout'], null, 1);

    expect((await workspace.agent.getWorkspaceSnapshot()).tabPresence)
      .toEqual({ work: true, explorations: false });
  });

  test('a facet snapshot identifies the actor whose frames its pane may admit', async () => {
    const workspace = orchestratorHarness();
    await workspace.started;
    await workspace.agent.setSoul('# Purpose\n\nCheck checkout.');
    const added = await workspace.agent.createSubordinateAgent();

    expect(await workspace.agent.getActorSnapshot(added.name)).toMatchObject({
      actorId: added.subordinate.actorId,
      name: added.name,
      displayName: added.displayName,
    });
  });
});
