/** The Work read names each task's owner by the path its conversation opens at: a helper with no chat tab is reached this way. */
import { describe, expect, test } from 'bun:test';
import { createTestActorsOver } from '@kinu.run/test-utils';
import { explorationActorKey, readWorkspaceWork, TaskListStore, type ActorHandle } from '../src/index';
import { createTestWorkspace } from './helpers';

describe('the workspace work read', () => {
  test('each task owner carries the subordinate path to its conversation, and none past a head', () => {
    const workspace = createTestWorkspace();
    const { directory, main } = createTestActorsOver(workspace.db, { name: 'workspace' });

    const child = (parent: ActorHandle, name: string, origin: 'agent' | 'swarm', lifetime: 'durable' | 'task') =>
      directory.create({ parent, name, creationId: `${parent.name}/${name}`, origin, lifetime });

    const refiner = child(main, 'ask-refiner-fb0gr9', 'agent', 'task');
    const nested = child(refiner, 'ask-checker-a1', 'agent', 'task');
    const head = child(main, explorationActorKey('head-1'), 'swarm', 'task');
    const underHead = child(head, 'ask-reader-b2', 'agent', 'task');

    for (const actor of [main, refiner, nested, head, underHead]) {
      new TaskListStore(workspace.sql, actor, (write) => workspace.db.transaction(write)()).add([`${actor.name}'s task`], null, 1);
    }

    const work = readWorkspaceWork(workspace.sql, main, directory.list({ retired: true }));
    const paths = Object.fromEntries(work.tasks.map(({ owner }) => [owner.name, owner.path]));

    expect(paths).toEqual({
      workspace: [],
      'ask-refiner-fb0gr9': ['ask-refiner-fb0gr9'],
      'ask-checker-a1': ['ask-refiner-fb0gr9', 'ask-checker-a1'],
      [explorationActorKey('head-1')]: null,
      'ask-reader-b2': null,
    });
  });

  test('a task owner is shown by its display name, and by its name when it has none', () => {
    const workspace = createTestWorkspace();
    const { directory, main } = createTestActorsOver(workspace.db, { name: 'workspace' });
    const auditor = directory.create({ parent: main, name: 'auditor', creationId: 'auditor', origin: 'agent', lifetime: 'durable' });
    const unnamed = directory.create({ parent: main, name: 'lookup-a1', creationId: 'lookup', origin: 'agent', lifetime: 'task' });
    auditor.config.setDisplayName('Coupon auditor');

    for (const actor of [auditor, unnamed]) {
      new TaskListStore(workspace.sql, actor, (write) => workspace.db.transaction(write)()).add(['a task'], null, 1);
    }

    const titles = readWorkspaceWork(workspace.sql, main, directory.list({ retired: true })).tasks.map(({ owner }) => [owner.name, owner.title]);

    expect(Object.fromEntries(titles)).toEqual({ auditor: 'Coupon auditor', 'lookup-a1': 'lookup-a1' });
  });
});
