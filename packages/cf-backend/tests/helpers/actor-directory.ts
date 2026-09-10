import { createTestSql } from '@kinu.run/test-utils';
import { createTestActor } from '../../../core/tests/helpers';
import { WorkspaceActorDirectory, type ActorDirectoryResult, type ChildActorOperation } from '@kinu.run/core';

/** Real directory semantics with only physical teardown supplied by the platform fixture. */
export function actorDirectoryFixture(remove: (entry: ActorDirectoryResult) => Promise<void>) {
  const database = createTestSql();
  createTestActor(database.sql, database.execRaw, 'fixture-workspace', 'main');
  const directory = new WorkspaceActorDirectory(database.sql, { workspaceId: 'fixture-workspace', ownerUserId: '' });
  const main = directory.main();

  return {
    directory,
    main,
    async apply(operation: ChildActorOperation): Promise<ActorDirectoryResult> {
      const entry = directory.apply(main, [], operation);

      if (operation.action !== 'retire' && operation.action !== 'cancelCreation') return entry;
      await remove(entry);

      return entry.state === 'deleted' ? entry : directory.apply(main, [], { action: 'release', name: entry.name, reference: entry.reference });
    },
  };
}
