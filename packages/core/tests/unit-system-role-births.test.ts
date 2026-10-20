/**
 * Every system role is hired the way a dream hires its two agents and the advisor lane its reviewer: a temporary
 * helper of origin `evolution`, born through the roster. A role id the roster cannot read back left a birth row no
 * listing could parse, and every agent list of the workspace failed after it (staging rc27, 2026-10-20: a dream's
 * `dream_reviewer`).
 */
import { describe, expect, test } from 'bun:test';
import { createTestSql } from '@kinu.run/test-utils';
import { createTestActor, makeSqlExec } from './helpers';
import { WorkspaceActorDirectory } from '../src/identity/workspace-actors';
import { SubordinateRosterStore } from '../src/subordinates/roster';
import { admitSubordinateBirth } from '../src/subordinates/birth';
import type { SubordinateRuntime } from '../src/subordinates/support';
import { SYSTEM_ROLE_DEFINITIONS } from '../src/profiles/catalog';
import { KinuError } from '../src/obs/error';
import { explorationActorKey } from '../src/identity/actor-key';

function setup() {
  const database = createTestSql();
  createTestActor(database.sql, database.execRaw, 'workspace', 'main');
  const directory = new WorkspaceActorDirectory(database.sql, { workspaceId: 'workspace', ownerUserId: '' });
  const main = directory.main();
  const roster = new SubordinateRosterStore(makeSqlExec(database.db), main);

  roster.ensureSchema();

  const unused = async (): Promise<never> => { throw new KinuError('unsupported', 'A birth asks nothing else here.'); };

  const runtime: SubordinateRuntime = {
    spawn: async (seed) => directory.apply(main, [], { action: 'register', name: seed.name, creationId: seed.creationId, origin: seed.origin, lifetime: seed.lifetime }).reference,
    cancelBirth: unused, assign: unused, status: unused, message: unused, rename: unused, dismiss: unused,
  };

  return { roster, runtime, database, directory, main };
}

describe('a system role hired as a temporary helper', () => {
  for (const role of Object.keys(SYSTEM_ROLE_DEFINITIONS)) {
    test(`${role} is born and listed`, async () => {
      const { roster, runtime } = setup();
      const name = `${role.replace(/[^a-z0-9]+/gu, '-')}-a1b2`;

      await admitSubordinateBirth(roster, runtime, {
        seed: { name, displayName: role, nameOrigin: 'auto', role, mission: 'Judge the drafted edits.', lifetime: 'task', origin: 'evolution' },
        assignment: null, createdAt: 1,
      });

      expect(roster.listAll().map((entry) => [entry.name, entry.origin, entry.birth])).toEqual([[name, 'evolution', null]]);
    });
  }
});

describe('the roster stores only what it reads back', () => {
  test('a birth it could not read back is refused at its write, and the roster lists on', async () => {
    const { roster, runtime } = setup();

    // The roster refuses the row as the birth is admitted, before any await.
    const born = async () => await admitSubordinateBirth(roster, runtime, {
      seed: { name: 'judge-a1b2', displayName: 'Judge', nameOrigin: 'auto', role: 'not_a_role', mission: 'Judge.', lifetime: 'task', origin: 'evolution' },
      assignment: null, createdAt: 1,
    });

    expect(born()).rejects.toThrow(/judge-a1b2.*birth\.seed\.role/u);
    expect(roster.listAll()).toEqual([]);
  });

  test('a stored row it cannot read says which row, and which field', () => {
    const { roster, database, directory, main } = setup();
    const node = directory.apply(main, [], { action: 'register', name: explorationActorKey('c1'), creationId: 'c1', origin: 'swarm', lifetime: 'task' });

    void database.sql`INSERT INTO actor_subordinates (actor_id, name, status, created_at, actor_reference, delete_requested)
      VALUES (${main.actorId}, 'node', 'idle', 1, ${JSON.stringify(node.reference)}, 0)`;
    expect(() => roster.listAll()).toThrow(/row "node", origin: /u);
  });
});
