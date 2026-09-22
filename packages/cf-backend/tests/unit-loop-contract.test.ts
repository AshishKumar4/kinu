/**
 * One promoted-loop contract for every full actor kind (open-41): the pinned scaffold version is selected and
 * recorded, with the live alias poisoned so an alias read is observable. The model is not driven here.
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

/** Install one version for one actor, flip its pointer, then poison `identity.scaffold.read()` so an alias read is observable. */
async function installVersion(
  fixture: HostedWorkspaceFixture, actor: HostedActor, version: number, marker: string,
): Promise<string> {
  const rt = actor.runtime;
  const source = markerSource(marker);
  const files = rt.agentStateVfs ?? rt.storage.vfs;
  await files.mkdir('scaffold', { recursive: true });
  await files.writeFile(`${rt.identity.scaffold.path}.v${String(version)}`, source);
  // UPSERT: acquiring the actor already seeded a v1 row.
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

/** One claimed turn via the production selection seam and ledger, returning the row the ledger wrote. */
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

  const context = actor.stores.history.context.selected() ?? actor.stores.history.context.initialize();

  const claim = await actor.stores.claims.admit({
    runId: `run-${turnId}`, turnId, workMode: 'build',
    program: programIdentityOf(program, 'harness-build'),
    context,
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

      expect(claimed.selectedVersion).toBe(1);
      expect(claimed.selectedSource).toContain(`v1:${subject.label}`);
      expect(claimed.selectedSource).not.toContain('POISONED-LIVE-ALIAS');

      // Pinned bytes, distinct from selection: recording the pointer's current value passes selection and fails the digest.
      expect(claimed.kind).toBe('scaffold');
      expect(claimed.version).toBe(1);
      expect(claimed.digest).toBe(digest);
    }

    // A mismatched actor id returns an empty set, not an error, so assert non-empty before comparing per-actor pointers.
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

      const secondDigest = await installVersion(fixture, subject.actor, 2, `v2:${subject.label}`);

      // Re-read from the ledger: a promotion mutating the stored claim would pass an in-memory comparison.
      const stored = subject.actor.stores.claims.read(`${subject.label}-inflight`);
      expect(stored).not.toBeNull();
      expect(stored?.program.kind).toBe('scaffold');
      expect(stored?.program.version).toBe(1);

      const next = await claimTurnOn(subject.actor, `${subject.label}-next`);
      expect(next.version).toBe(2);
      expect(next.digest).toBe(secondDigest);
      expect(next.selectedSource).toContain(`v2:${subject.label}`);
    }
  });

  test('heads in both modes inherit the parent loop; a hire starts builtin', async () => {
    // The origin is a function of the kind, so it holds at creation sites this suite never drives.
    const expected: readonly (readonly [WorkspaceActor['kind'], 'builtin' | 'inherit'])[] = [
      ['main', 'builtin'], ['subordinate', 'builtin'], ['head', 'inherit'], ['branch', 'inherit'],
    ];

    for (const [kind, origin] of expected) {
      expect(defaultLoopOrigin(kind).kind).toBe(origin);
    }

    // Promote the parent twice: inheriting when only v1 exists cannot distinguish a copy from a fresh bootstrap.
    const fixture = await hostedWorkspace();
    const main = await fixture.host.acquire(fixture.main);
    await installVersion(fixture, main, 1, 'v1:root');
    await installVersion(fixture, main, 2, 'v2:root');
    const head = await fixture.hire(fixture.main, 'exp:head-b1', 'head');
    const node = await fixture.hire(fixture.main, 'exp:node-b2', 'head');
    const hired = await fixture.hire(fixture.main, 'sub-hired-b3', 'subordinate');

    // A copy, not a pointer: a child reading its parent's row could not verify its claim after the parent promoted again.
    for (const child of [head, node]) {
      const row = fixture.sql<{ version: number; parent_version: number | null }>`
        SELECT version, parent_version FROM scaffold_versions
        WHERE actor_id = ${child.handle.actorId} AND status = 'current'`[0];

      expect(row?.version).toBe(1);
      expect(row?.parent_version).toBe(2);
      const rt = child.runtime;

      const raw = await (rt.agentStateVfs ?? rt.storage.vfs)
        .readFile(`${rt.identity.scaffold.path}.v1`, { encoding: 'utf8' });

      // `encoding: 'utf8'` was requested, so a non-string is the plane breaking its contract.
      const source = v.parse(v.string(), raw);
      expect(source).toContain('v2:root');
    }

    const hiredRow = fixture.sql<{ parent_version: number | null }>`
      SELECT parent_version FROM scaffold_versions
      WHERE actor_id = ${hired.handle.actorId} AND status = 'current'`[0];

    expect(hiredRow?.parent_version).toBeNull();
  });
});
