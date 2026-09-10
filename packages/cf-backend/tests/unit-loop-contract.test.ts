/**
 * ONE PROMOTED-LOOP CONTRACT FOR EVERY FULL ACTOR KIND (open-41).
 *
 * The claim, per kind — root, hired subordinate, ask-by-role temporary,
 * branching head, and a second head seated as a swarm node:
 *
 *   1. Install `<that actor's scaffold path>.v1` with a marker only that version
 *      can produce, flip THAT actor's `scaffold_versions` pointer to it, and
 *      POISON the live alias by making `identity.scaffold.read()` answer a
 *      different program. The poison is what makes every assertion below
 *      non-vacuous: an implementation that resolved the alias instead of the
 *      pinned version returns the poisoned source, so "v1 was selected" cannot
 *      be satisfied by an implementation that never read the version at all.
 *   2. Assert the SELECTED program is v1 and carries the v1 bytes.
 *   3. Assert the CLAIM the turn is admitted under records
 *      `program_kind='scaffold'`, `program_version=1` and
 *      `program_digest=sha256(v1 source)`. A claim that recorded the pointer's
 *      current value rather than the bytes it pinned passes (2) and fails this.
 *   4. Promote v2 and assert the IN-FLIGHT claim still reads v1 from the LEDGER
 *      while the next preparation selects v2. Re-reading from the ledger is
 *      load-bearing: a promotion that mutated the stored claim would satisfy an
 *      in-memory comparison of the object `admit` returned and fail this.
 *   5. For heads in both modes, assert the loop ORIGIN was `inherit` — they run
 *      the parent's promoted loop and never a fresh v0, because a fork of an
 *      actor's reasoning that started from nothing the actor had learned is not
 *
 * WHERE THIS PROVES ITS POINT, and where it does not. The selection seam
 * (`prepareActorProgram`) and the claim ledger are production code and are
 * driven here directly. What is NOT driven is the model: a hosted actor's turn
 * runs through `startActorTurn`, which needs a provider, so this file asserts
 * that the pinned version is the one SELECTED and RECORDED rather than watching
 * a marker come out of an emitted event. The root's own arm of that stronger
 * proof — a scripted model emitting the marker — lives in
 * `unit-actor-program-selection.test.ts`, which is the one path that is not
 * shared: the workspace root drives Think's own loop rather than an
 * `ActorSession`.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  defaultLoopOrigin, prepareActorProgram, programIdentityOf, sha256Hex,
  type HostedActor, type WorkspaceActor,
} from '@kinu.run/core';
import { hostedWorkspace, resetDatabases, type HostedWorkspaceFixture } from './helpers/hosted-workspace';

/** A program whose only job is to be identifiable by its bytes. */
function markerSource(marker: string): string {
  return `async function run() { await host.emit({ type: "text_delta", text: ${JSON.stringify(marker)} }); }\n`;
}

/**
 * Install one version's bytes for one actor and flip that actor's pointer to
 * it, then POISON the live alias.
 *
 * The pointer write is the production recipe (`scaffold_versions`, one `current`
 * row per actor, keyed by `actor_id`), and the poison is the alias resolution
 * seam itself: `identity.scaffold.read()` is what a loop reaches when it
 * resolves the live file rather than the pinned version, so overriding it to
 * answer a DIFFERENT program is what makes an alias read observable instead of
 * merely wrong.
 */
async function installVersion(
  fixture: HostedWorkspaceFixture, actor: HostedActor, version: number, marker: string,
): Promise<string> {
  const rt = actor.runtime;
  const source = markerSource(marker);
  const files = rt.agentStateVfs ?? rt.storage.vfs;
  await files.mkdir('scaffold', { recursive: true });
  await files.writeFile(`${rt.identity.scaffold.path}.v${String(version)}`, source);
  // UPSERT, because acquiring the actor already seeded a v1 row: the pointer
  // write is the production recipe (one `current` row per actor, retired rows
  // `historical`), applied to the row the seeding left rather than beside it.
  fixture.db.query(
    `INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
     VALUES (?, ?, ?, 'loop contract proof', 'current')
     ON CONFLICT (actor_id, version) DO UPDATE SET rationale = 'loop contract proof', status = 'current'`,
  ).run(rt.actor.actorId, version, Date.now());
  fixture.db.query(
    "UPDATE scaffold_versions SET status = 'historical' WHERE actor_id = ? AND version != ? AND status = 'current'",
  ).run(rt.actor.actorId, version);
  rt.identity.scaffold.read = () => Promise.resolve(markerSource('POISONED-LIVE-ALIAS'));

  return sha256Hex(source);
}

/** One claimed turn on one actor, driven through the production selection seam
 *  and the production ledger, returning the row the ledger actually wrote. */
async function claimTurnOn(actor: HostedActor, turnId: string): Promise<{
  readonly selectedVersion: number;
  readonly selectedSource: string | null;
  readonly kind: string;
  readonly version: number;
  readonly digest: string | null;
}> {
  const program = await prepareActorProgram({
    runtime: actor.runtime, mode: 'build',
    version: await actor.runtime.identity.scaffold.version(),
  });

  const claim = actor.stores.claims.admit({
    runId: `run-${turnId}`, turnId, workMode: 'build',
    program: programIdentityOf(program, 'harness-build'),
    context: [],
    workingRevision: 0,
  });

  return {
    selectedVersion: program.version,
    selectedSource: program.kind === 'scaffold' ? program.source : null,
    kind: claim.program.kind,
    version: claim.program.version,
    digest: claim.program.digest,
  };
}

interface Subject {
  readonly label: string;
  readonly actor: HostedActor;
  readonly record: WorkspaceActor;
  readonly expectedOrigin: 'builtin' | 'inherit';
}

async function subjects(fixture: HostedWorkspaceFixture): Promise<readonly Subject[]> {
  const main = await fixture.host.acquire(fixture.main);
  const hired = await fixture.hire(fixture.main, 'sub-hired-1', 'subordinate');
  const temporary = await fixture.hire(fixture.main, 'sub-temp-2', 'subordinate');
  const head = await fixture.hire(fixture.main, 'exp:head-a1', 'head');
  const node = await fixture.hire(fixture.main, 'exp:node-b2', 'head');

  return [
    { label: 'root', actor: main, record: main.record, expectedOrigin: 'builtin' },
    { label: 'hired', actor: hired, record: hired.record, expectedOrigin: 'builtin' },
    { label: 'temporary', actor: temporary, record: temporary.record, expectedOrigin: 'builtin' },
    { label: 'head', actor: head, record: head.record, expectedOrigin: 'inherit' },
    { label: 'node', actor: node, record: node.record, expectedOrigin: 'inherit' },
  ];
}

describe('the promoted-loop contract holds for every full actor kind', () => {
  afterEach(() => { resetDatabases(); });

  test('each kind selects its OWN pinned version with the live alias poisoned', async () => {
    const fixture = await hostedWorkspace();
    const roster = await subjects(fixture);

    for (const subject of roster) {
      const digest = await installVersion(fixture, subject.actor, 1, `v1:${subject.label}`);
      const claimed = await claimTurnOn(subject.actor, `${subject.label}-first`);

      // WHICH BYTES were selected. Non-vacuous because the alias answers a
      // different program: an arm that resolved it would carry the poison here.
      expect(claimed.selectedVersion).toBe(1);
      expect(claimed.selectedSource).toContain(`v1:${subject.label}`);
      expect(claimed.selectedSource).not.toContain('POISONED-LIVE-ALIAS');

      // WHICH BYTES were PINNED. Distinct from the above on purpose: an
      // implementation that recorded the pointer's current value rather than the
      // source it selected passes the selection assertions and fails the digest.
      expect(claimed.kind).toBe('scaffold');
      expect(claimed.version).toBe(1);
      expect(claimed.digest).toBe(digest);
    }

    // FIVE actors, five pinned pointers, one database — a shared pointer would
    // make one promotion move all five, and this is the read that would catch
    // it. Asserted NON-EMPTY first: a mismatched actor id returns an empty set
    // rather than an error, so a predicate that scoped to the wrong handle
    // would otherwise sail through every assertion above.
    const current = fixture.sql<{ actor_id: string; version: number }>`
      SELECT actor_id, version FROM scaffold_versions WHERE status = 'current'`;

    expect(current.length).toBe(5);
    expect(new Set(current.map((row) => row.actor_id)).size).toBe(5);
  });

  test('a promotion does not move the claim already admitted, per actor', async () => {
    const fixture = await hostedWorkspace();

    for (const subject of await subjects(fixture)) {
      await installVersion(fixture, subject.actor, 1, `v1:${subject.label}`);
      const inFlight = await claimTurnOn(subject.actor, `${subject.label}-inflight`);
      expect(inFlight.version).toBe(1);

      // v2 lands WHILE that claim is open.
      const secondDigest = await installVersion(fixture, subject.actor, 2, `v2:${subject.label}`);

      // Re-read from the LEDGER rather than trusting the value returned above:
      // a promotion that mutated the stored claim would satisfy an in-memory
      // comparison and fail this. Non-empty by assertion, for the reason the
      // previous test states.
      const stored = subject.actor.stores.claims.read(`${subject.label}-inflight`);
      expect(stored).not.toBeNull();
      expect(stored?.program.kind).toBe('scaffold');
      expect(stored?.program.version).toBe(1);

      // The NEXT turn takes v2, and carries v2's bytes.
      const next = await claimTurnOn(subject.actor, `${subject.label}-next`);
      expect(next.version).toBe(2);
      expect(next.digest).toBe(secondDigest);
      expect(next.selectedSource).toContain(`v2:${subject.label}`);
    }
  });

  test('heads in both modes inherit the parent loop; a hire starts builtin', async () => {
    // The POLICY, from the one function every creation site defaults through.
    // No actors needed: the origin is a function of the kind, which is what
    // makes it hold at sites this suite never drives. A swarm node's seat is a
    // head row, so the node arm below runs the head assertion, not a kind the
    // directory no longer issues.
    const expected: readonly (readonly [WorkspaceActor['kind'], 'builtin' | 'inherit'])[] = [
      ['main', 'builtin'], ['subordinate', 'builtin'], ['head', 'inherit'], ['branch', 'inherit'],
    ];

    for (const [kind, origin] of expected) {
      expect(defaultLoopOrigin(kind).kind).toBe(origin);
    }

    // And the OBSERVABLE CONSEQUENCE of `inherit`. Promote the parent TWICE
    // first, so "the parent's promoted loop" is non-vacuous: inheriting when
    // only v1 exists cannot distinguish a copy from a fresh bootstrap.
    const fixture = await hostedWorkspace();
    const main = await fixture.host.acquire(fixture.main);
    await installVersion(fixture, main, 1, 'v1:root');
    await installVersion(fixture, main, 2, 'v2:root');
    const head = await fixture.hire(fixture.main, 'exp:head-b1', 'head');
    const node = await fixture.hire(fixture.main, 'exp:node-b2', 'head');
    const hired = await fixture.hire(fixture.main, 'sub-hired-b3', 'subordinate');

    // An inheriting child runs the parent's PROMOTED bytes as its own v1 and
    // NAMES the parent version it was cut from — a copy, not a pointer. A
    // child that read its parent's row would run bytes its own claim could
    // not verify after the parent promoted again.
    for (const child of [head, node]) {
      const row = fixture.sql<{ version: number; parent_version: number | null }>`
        SELECT version, parent_version FROM scaffold_versions
        WHERE actor_id = ${child.handle.actorId} AND status = 'current'`[0];

      expect(row?.version).toBe(1);
      expect(row?.parent_version).toBe(2);
      const rt = child.runtime;

      const raw = await (rt.agentStateVfs ?? rt.storage.vfs)
        .readFile(`${rt.identity.scaffold.path}.v1`, { encoding: 'utf8' });

      // Parsed, not sniffed: `encoding: 'utf8'` was requested, so anything but
      // a string is the plane breaking its own contract and must say so here.
      const source = v.parse(v.string(), raw);
      expect(source).toContain('v2:root');
    }

    // A hire starts builtin: a fresh bootstrap with no parent version named.
    const hiredRow = fixture.sql<{ parent_version: number | null }>`
      SELECT parent_version FROM scaffold_versions
      WHERE actor_id = ${hired.handle.actorId} AND status = 'current'`[0];

    expect(hiredRow?.parent_version).toBeNull();
  });
});
