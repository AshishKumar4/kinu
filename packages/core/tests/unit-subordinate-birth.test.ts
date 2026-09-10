import { describe, expect, test } from 'bun:test';
import { createTestActors, createTestSql } from '@kinu.run/test-utils';
import { createTestActor, makeSqlExec } from './helpers';
import { WorkspaceActorDirectory } from '../src/identity/workspace-actors';
import { actorReferenceOf } from '../src/identity/actor-handle';
import { SubordinateRosterStore } from '../src/subordinates/roster';
import { finishSubordinateBirth, recoverSubordinateLifecycles } from '../src/subordinates/birth';
import { admitSubordinateTask, describeSubordinateHandoff, type SubordinateRuntime } from '../src/subordinates/support';
import { EventLog } from '../src/events/hub/log';
import { initEventsHubTables } from '../src/events/hub/schema';
import { KinuError } from '../src/obs/error';

function setup() {
  const database = createTestSql();
  createTestActor(database.sql, database.execRaw, 'workspace', 'main');
  const directory = new WorkspaceActorDirectory(database.sql, { workspaceId: 'workspace', ownerUserId: '' });
  const main = directory.main();
  // The roster is the PARENT's: a subordinate name is chosen by the actor that
  // hired it, so two actors of one workspace really do hire the same 'reader'.
  const roster = new SubordinateRosterStore(makeSqlExec(database.db), main);
  roster.ensureSchema();
  const child = createTestSql();
  initEventsHubTables(makeSqlExec(child.db));
  // The subordinate's OWN inbox, over the subordinate's own database — the
  // admitted task is the child's to drain, never the parent's.
  const childActor = createTestActors(child.sql, child.execRaw).main;
  const events = new EventLog(makeSqlExec(child.db), childActor);
  let interruptSeed = false;
  let interruptAssignment = false;
  let interruptDeletion = false;

  const runtime: SubordinateRuntime = {
    spawn: async (seed) => {
      const entry = directory.apply(main, [], { action: 'register', name: seed.name, creationId: seed.creationId, kind: 'subordinate', lifetime: seed.lifetime });

      if (interruptSeed) { interruptSeed = false; throw new KinuError('unavailable', 'Seed acknowledgement lost.'); }

      return entry.reference;
    },
    cancelBirth: async (seed) => {
      const actor = directory.apply(main, [], { action: 'cancelCreation', name: seed.name, creationId: seed.creationId, kind: 'subordinate', lifetime: seed.lifetime });

      if (actor.state !== 'deleted') directory.apply(main, [], { action: 'release', name: seed.name, reference: actor.reference });

      return actor.reference;
    },
    assign: async (_name, input) => {
      const admission = admitSubordinateTask(events, { ...input, fromWorkspace: 'workspace', kind: 'task', now: 100 });

      if (interruptAssignment) { interruptAssignment = false; throw new KinuError('unavailable', 'Assignment acknowledgement lost.'); }

      return describeSubordinateHandoff({ admission, turnInFlight: false, live: { lastActivity: 0, recentSteps: [] } });
    },
    status: async () => ({ lastActivity: 0, recentSteps: [] }),
    message: async () => { throw new KinuError('unsupported', 'This test does not send a second message.'); },
    rename: async () => { throw new KinuError('unsupported', 'This test does not rename actors.'); },
    dismiss: async (name, keepHistory, reference) => {
      if (keepHistory) return;
      const actor = directory.apply(main, [], { action: 'retire', name, reference });

      if (interruptDeletion) { interruptDeletion = false; throw new KinuError('unavailable', 'Deletion acknowledgement lost.'); }

      if (actor.state !== 'deleted') directory.apply(main, [], { action: 'release', name, reference });
    },
  };

  const admit = (creationId: string) => roster.create({
    name: 'reader', actorReference: null, deleteRequested: false,
    birth: { creationId, seed: { name: 'reader', displayName: '', nameOrigin: 'auto', role: 'researcher', mission: 'Read the source.', lifetime: 'durable' }, assignment: { body: 'Read the source.', mode: 'plan' } },
    createdBy: 'orchestrator', status: 'working', currentTask: 'Read the source.', createdAt: 100, dismissedAt: null, lifetime: 'durable', taskEventId: null,
  });

  return { database, child, childActor, directory, main, roster, runtime, admit,
    interruptSeed: () => { interruptSeed = true; }, interruptAssignment: () => { interruptAssignment = true; }, interruptDeletion: () => { interruptDeletion = true; } };
}

describe('admitted subordinate lifecycle', () => {
  test('a lost seed acknowledgement recovers the same actor after a cold roster open', async () => {
    const fixture = setup();
    fixture.admit('birth-one');
    fixture.interruptSeed();
    await expect(finishSubordinateBirth(fixture.roster, fixture.runtime, 'reader')).rejects.toMatchObject({ code: 'unavailable' });
    const issued = fixture.directory.resolveChild(fixture.main, 'reader');

    if (!issued) throw new Error('Registration did not land.');
    const cold = new SubordinateRosterStore(makeSqlExec(fixture.database.db), fixture.main);
    await recoverSubordinateLifecycles(cold, fixture.runtime);
    expect(cold.requireExisting('reader').actorReference).toEqual(actorReferenceOf(issued));
    expect(cold.requireExisting('reader').birth).toBeNull();
    expect(cold.requireExisting('reader').taskEventId).toBeString();
  });

  test('a lost first assignment acknowledgement does not admit the task twice', async () => {
    const fixture = setup();
    fixture.admit('birth-one');
    fixture.interruptAssignment();
    await expect(finishSubordinateBirth(fixture.roster, fixture.runtime, 'reader')).rejects.toMatchObject({ code: 'unavailable' });
    await recoverSubordinateLifecycles(new SubordinateRosterStore(makeSqlExec(fixture.database.db), fixture.main), fixture.runtime);

    const rows = fixture.child.sql<{ count: number }>`SELECT COUNT(*) AS count FROM agent_log
      WHERE actor_id = ${fixture.childActor.actorId}
        AND kind = 'event' AND variant = 'subordinate_task'`;

    expect(rows[0]?.count).toBe(1);
    expect(fixture.roster.requireExisting('reader').birth).toBeNull();
  });

  test('failed destructive cleanup keeps intent and removes only its old row after retry', async () => {
    const fixture = setup();
    fixture.admit('birth-one');
    const reference = await finishSubordinateBirth(fixture.roster, fixture.runtime, 'reader');
    fixture.roster.requestDeletion('reader', reference, 101);
    fixture.interruptDeletion();
    await expect(recoverSubordinateLifecycles(fixture.roster, fixture.runtime)).rejects.toMatchObject({ code: 'unavailable' });
    expect(fixture.roster.requireExisting('reader').deleteRequested).toBe(true);
    await recoverSubordinateLifecycles(fixture.roster, fixture.runtime);
    expect(fixture.roster.get('reader')).toBeNull();
    fixture.admit('birth-two');
    const replacement = await finishSubordinateBirth(fixture.roster, fixture.runtime, 'reader');
    expect(replacement.actorId).not.toBe(reference.actorId);
    expect(() => fixture.roster.removeActor('reader', reference)).toThrow(expect.objectContaining({ code: 'denied' }));
    expect(fixture.roster.requireExisting('reader').actorReference).toEqual(replacement);
  });
});
