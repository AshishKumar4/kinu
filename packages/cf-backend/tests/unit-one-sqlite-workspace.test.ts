/**
 * One physical workspace SQLite for every logical actor (open-38): five actors, one database, and its archive restores
 * every actor. Non-vacuous: exactly one `Database` opened, rows read per `actor_id`, restore compared per actor.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  archiveSqlFromDatabase, CHAT_SESSION_ID, prepareActorProgram, programIdentityOf,
  readWorkspaceArchivePage, restoreWorkspaceArchive, type ArchivePage, type HostedActor,
} from '@kinu.run/core';
import {
  databasesOpened, fixtureProfile, hostedWorkspace, resetDatabases,
  type HostedWorkspaceFixture,
} from './helpers/hosted-workspace';
import { readTranscriptRows, sqlOver } from '@kinu.run/test-utils';

/** Admit, name the outcome, release: the smallest thing that leaves a durable claim. */
async function scriptedTurn(actor: HostedActor, text: string): Promise<string> {
  const turnId = `turn-${actor.record.name}`;
  const { profile, inputs } = fixtureProfile();
  const lease = actor.session.beginTurn({ runId: `run-${actor.record.name}`, turnId }, 'build', Date.now());
  actor.session.bindProfile(lease, profile, inputs);
  await actor.session.openTurnInput(lease, {
    item: {}, message: { role: 'user', content: text },
    birthContext: () => { throw new Error('this fixture opens no delegated turn'); },
  });

  // Admitted and settled through the session's own store; the session attaches a claim only inside `execute`,
  // which needs a provider this fixture lacks.
  const program = await prepareActorProgram({
    runtime: actor.runtime, mode: 'build',
    version: await actor.runtime.identity.scaffold.version(),
  });

  const selected = actor.stores.history.context.selected();

  if (selected === null) throw new Error('an opened turn must have a working context');

  const admitted = await actor.stores.claims.admit({
    runId: lease.runId, turnId, workMode: 'build',
    program: programIdentityOf(program, 'harness-build'),
    context: selected,
  });

  actor.stores.claims.settle(admitted, 'completed');
  actor.session.finishTurn(lease);

  // Through the canonical writer: the archive must bring back the transcript, not just a working context.
  await actor.stores.history.record(CHAT_SESSION_ID, {
    id: `${turnId}:said`, parentId: null, message: { role: 'user', content: text }, origin: 'input',
  });

  return turnId;
}

describe('one SQLite for every logical actor', () => {
  afterEach(() => { resetDatabases(); });

  test('five actors, one database, and no actor without rows of its own', async () => {
    const fixture: HostedWorkspaceFixture = await hostedWorkspace();
    const main = await fixture.host.acquire(fixture.main);
    const first = await fixture.hire(fixture.main, 'sub-reader-1', 'subordinate');
    const second = await fixture.hire(fixture.main, 'sub-writer-2', 'subordinate');
    const head = await fixture.hire(fixture.main, 'exp:head-a1', 'head');
    const node = await fixture.hire(fixture.main, 'exp:node-b2', 'head');
    const actors = [main, first, second, head, node];

    // Asserted first: every assertion below would read true over a fixture that had opened five.
    expect(databasesOpened()).toHaveLength(1);
    expect(fixture.tables()).toContain('workspace_actors');

    for (const actor of actors) await scriptedTurn(actor, `work for ${actor.record.name}`);

    // Distinctness is what a shared-row implementation fails.
    const ids = actors.map((actor) => actor.handle.actorId);
    expect(new Set(ids).size).toBe(5);

    for (const actor of actors) {
      const claims = fixture.sql<{ actor_id: string; turn_id: string }>`
        SELECT actor_id, turn_id FROM actor_turn_claims WHERE actor_id = ${actor.handle.actorId}`;

      expect(claims.map((row) => row.turn_id)).toEqual([`turn-${actor.record.name}`]);
    }

    const pointers = fixture.sql<{ actor_id: string }>`
      SELECT DISTINCT actor_id FROM scaffold_versions`;

    expect(new Set(pointers.map((row) => row.actor_id)).size).toBe(5);
  });

  test('the archive of the one database is the whole workspace, and restores per actor', async () => {
    const fixture = await hostedWorkspace();
    const main = await fixture.host.acquire(fixture.main);

    const roster = [
      main,
      await fixture.hire(fixture.main, 'sub-reader-1', 'subordinate'),
      await fixture.hire(fixture.main, 'sub-writer-2', 'subordinate'),
      await fixture.hire(fixture.main, 'exp:head-a1', 'head'),
      await fixture.hire(fixture.main, 'exp:node-b2', 'head'),
    ];

    for (const actor of roster) await scriptedTurn(actor, `work for ${actor.record.name}`);

    // Paged to exhaustion (rows have no bounded size), in the sequence `kinu import` would replay.
    const pages: ArchivePage[] = [];
    let cursor: Parameters<typeof readWorkspaceArchivePage>[1]['cursor'] = null;
    const archiveSql = archiveSqlFromDatabase(fixture.db);

    for (;;) {
      const page = await readWorkspaceArchivePage(archiveSql, {
        workspace: 'harness', source: 'cloud', cursor,
      });

      pages.push(page);

      if (page.next === undefined || page.next === null) break;
      cursor = page.next;
    }

    const restored = new Database(':memory:');

    const result = await restoreWorkspaceArchive(
      archiveSqlFromDatabase(restored), pages.flatMap((page) => page.lines),
    );

    // A restore refuses an archive whose declared roster size (retired included) does not match what it rebuilt.
    expect(result.actors).toBe(5);

    // Per actor: a restore that merged two actors or dropped one satisfies a total.
    for (const actor of roster) {
      const files = actor.runtime.storage.vfs;
      const before = await readTranscriptRows(fixture.sql, actor.handle, files);
      const after = await readTranscriptRows(sqlOver(restored), actor.handle, files);

      // Non-empty first: two empty reads would satisfy "equal transcripts".
      expect(before.map((row) => row.content)).toEqual([`work for ${actor.record.name}`]);
      expect(after).toEqual(before);

      const claims = sqlOver(restored)<{ turn_id: string }>`
        SELECT turn_id FROM actor_turn_claims WHERE actor_id = ${actor.handle.actorId}`;

      expect(claims.map((row) => row.turn_id)).toEqual([`turn-${actor.record.name}`]);

      const versions = sqlOver(restored)<{ n: number }>`
        SELECT COUNT(*) AS n FROM scaffold_versions WHERE actor_id = ${actor.handle.actorId}`[0]?.n ?? 0;

      expect(versions).toBeGreaterThan(0);
    }

    restored.close();
  });
});
