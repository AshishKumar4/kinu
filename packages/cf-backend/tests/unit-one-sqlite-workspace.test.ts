/**
 * ONE PHYSICAL WORKSPACE SQLITE FOR EVERY LOGICAL ACTOR (open-38).
 *
 * The whole claim in one file: a workspace with a main actor, two hired
 * subordinates, a branching head and a swarm node touches exactly ONE database,
 * every one of those five actors has its own rows in it, and the archive of that
 * database is a complete workspace — export it, restore it into an empty
 * database, and all five actors' transcripts, scaffold pointers and turn claims
 * come back.
 *
 * WHAT MAKES THIS NON-VACUOUS, because a "one database" test is easy to write
 * so that it cannot fail:
 *
 *   • `databasesOpened()` is asserted to have LENGTH ONE. The fixture is the
 *     only thing in the tree that opens a `Database`, so a regression that gave
 *     any actor storage of its own has to open a second one and fails here
 *     before any per-actor assertion could pass over it.
 *   • Every actor's rows are read by `actor_id` from `sqlite_master`'s own
 *     tables, so "the subordinate has a transcript" and "the subordinate's
 *     transcript is distinct from the main actor's" are separate assertions and
 *     the second is what a shared-row implementation fails.
 *   • The restore is compared per actor and not in aggregate. A restore that
 *     rebuilt four actors out of five, or merged two into one, passes a row
 *     count and fails this.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  archiveSqlFromDatabase, prepareActorProgram, programIdentityOf, readWorkspaceArchivePage,
  restoreWorkspaceArchive, type ArchivePage, type HostedActor,
} from '@kinu.run/core';
import {
  databasesOpened, fixtureProfile, harnessSql, hostedWorkspace, resetDatabases,
  type HostedWorkspaceFixture,
} from './helpers/hosted-workspace';

/** One scripted turn on one actor: admit it, name its outcome, release it. The
 *  smallest thing that leaves a durable claim, which is what every assertion
 *  below reads. */
async function scriptedTurn(actor: HostedActor, text: string): Promise<string> {
  const turnId = `turn-${actor.record.name}`;
  const { profile, inputs } = fixtureProfile();
  const lease = actor.session.beginTurn({ runId: `run-${actor.record.name}`, turnId }, 'build', Date.now());
  actor.session.bindProfile(lease, profile, inputs);
  actor.session.appendInput(lease, { role: 'user', content: text });
  // The claim, admitted through the same store the session admits through and
  // settled through the same store the session settles through — the session
  // only attaches a claim to a lease inside `execute`, which needs a provider
  // this fixture has none of. What it costs is the model call, not the claim,
  // and the claim row is what every assertion below reads. The lease itself
  // never ran, so releasing it names nothing.
  const program = await prepareActorProgram({
    runtime: actor.runtime, mode: 'build',
    version: await actor.runtime.identity.scaffold.version(),
  });
  const admitted = actor.stores.claims.admit({
    runId: lease.runId, turnId, workMode: 'build',
    program: programIdentityOf(program, 'harness-build'),
    context: actor.session.history,
    workingRevision: 0,
  });
  actor.stores.claims.settle(admitted, 'completed');
  actor.session.finishTurn(lease);
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

    // THE measurement. One database exists, so there is no per-actor storage to
    // find — and this is asserted before anything else, because every assertion
    // below it would read true over a fixture that had opened five.
    expect(databasesOpened()).toHaveLength(1);
    expect(fixture.tables()).toContain('workspace_actors');

    for (const actor of actors) await scriptedTurn(actor, `work for ${actor.record.name}`);

    // Five distinct actor ids, five distinct claim sets. The DISTINCTNESS is the
    // assertion a shared-row implementation fails: it would satisfy "every actor
    // has a claim" with one row read five times.
    const ids = actors.map((actor) => actor.handle.actorId);
    expect(new Set(ids).size).toBe(5);
    for (const actor of actors) {
      const claims = fixture.sql<{ actor_id: string; turn_id: string }>`
        SELECT actor_id, turn_id FROM actor_turn_claims WHERE actor_id = ${actor.handle.actorId}`;
      expect(claims.map((row) => row.turn_id)).toEqual([`turn-${actor.record.name}`]);
    }

    // Every actor's scaffold pointer is its own, which is what lets five actors
    // run five different promoted programs out of one database.
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

    // Walked to exhaustion, as a caller does: a workspace's rows have no
    // bounded size, so the archive is paged and `next` is what says there is
    // more. Collected whole here because the restore below has to be handed the
    // same sequence a `kinu import` would replay.
    // Walked to exhaustion, as a caller does: a workspace's rows have no
    // bounded size, so the archive is paged and `next` is what says there is
    // more. Collected whole here because the restore below has to be handed the
    // same line sequence a `kinu import` would replay.
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

    // The archive declares its roster size, retired actors included, and a
    // restore refuses an archive whose count does not match what it rebuilt —
    // which is what makes "one snapshot contains every retained actor"
    // checkable rather than implied.

    const restored = new Database(':memory:');
    const result = await restoreWorkspaceArchive(
      archiveSqlFromDatabase(restored), pages.flatMap((page) => page.lines),
    );
    // The archive DECLARES its roster size, retired actors included, and a
    // restore refuses an archive whose count does not match what it rebuilt —
    // which is what makes "one snapshot contains every retained actor"
    // checkable rather than implied.
    expect(result.actors).toBe(5);

    // PER ACTOR, not in aggregate: a restore that merged two actors or dropped
    // one satisfies a total and fails this.
    for (const actor of roster) {
      const before = fixture.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM messages WHERE actor_id = ${actor.handle.actorId}`[0]?.n ?? 0;
      const after = harnessSql(restored)<{ n: number }>`
        SELECT COUNT(*) AS n FROM messages WHERE actor_id = ${actor.handle.actorId}`[0]?.n ?? 0;
      expect(after).toBe(before);

      const claims = harnessSql(restored)<{ turn_id: string }>`
        SELECT turn_id FROM actor_turn_claims WHERE actor_id = ${actor.handle.actorId}`;
      expect(claims.map((row) => row.turn_id)).toEqual([`turn-${actor.record.name}`]);

      const versions = harnessSql(restored)<{ n: number }>`
        SELECT COUNT(*) AS n FROM scaffold_versions WHERE actor_id = ${actor.handle.actorId}`[0]?.n ?? 0;
      expect(versions).toBeGreaterThan(0);
    }
    restored.close();
  });
});
