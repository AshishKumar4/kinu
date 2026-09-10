// seedActorLoop — every created actor has an explicit loop origin.
//
// The defect this closes: a branching head and a hosted swarm node opened a
// FRESH scaffold store, found no row and ran the shipped bootstrap loop. So a
// workspace whose owner had promoted three generations of loop still explored
// with the first one, and nothing anywhere said so. `LoopOrigin` makes "no
// origin" unrepresentable, and these cases prove each arm against real bytes
// and a real pointer rather than against the words of the enum.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { sqlOver, createMemoryVfs, createTestRuntime } from '@kinu.run/test-utils';
import { INITIAL_SCAFFOLD_SOURCE, defaultLoopOrigin, seedActorLoop } from '../src/scaffold/bootstrap';
import { initScaffoldTables } from '../src/scaffold/schemas';
import { getCurrentScaffoldVersion } from '../src/scaffold/shadow';
import { readScaffoldFileText } from '../src/scaffold/surface';
import { WORKSPACE_IDENTITY_DDL } from '../src/identity/schema';
import { initWorkspaceActorTable, WorkspaceActorDirectory } from '../src/identity/workspace-actors';
import { initAgentConfigTable } from '../src/config/store';
import { initCodemodeStateTable } from '../src/identity/program-state';
import type { AgentRuntime } from '../src/types/agent-runtime';
// From the modules that own them, NOT the barrel: `core/src/index.ts` re-exports
// the actor host, whose own imports land with the context plane, and this suite
// must be runnable on its own before that merge.
import type { Identity, SqlExecutor, VFS } from '../src/types/primitives';
import type { ActorHandle } from '../src/identity/actor-handle';

const PARENT_V1 = '// parent v1 — the promoted loop\nasync function* run(rt, task) { yield "v1"; }\n';
const PARENT_V2 = '// parent v2 — promoted later\nasync function* run(rt, task) { yield "v2"; }\n';

interface Fixture {
  readonly sql: SqlExecutor;
  readonly directory: WorkspaceActorDirectory;
  readonly main: ActorHandle;
  actorRuntime(handle: ActorHandle, name: string): AgentRuntime;
}

function scaffoldIdentity(name: string, vfs: VFS, sql: SqlExecutor, actorId: string): Identity {
  const path = `agents/${name}/scaffold/agent.js`;
  return {
    id: `actor-${name}`,
    name,
    scaffold: {
      path,
      exists: () => vfs.exists(path),
      read: () => readScaffoldFileText(vfs, path),
      write: (source: string) => vfs.writeFile(path, source),
      version: async () => sql<{ version: number | null }>`
        SELECT MAX(version) AS version FROM scaffold_versions WHERE actor_id = ${actorId}`[0]?.version ?? 0,
    },
  };
}

function build(): Fixture {
  const db = new Database(':memory:');
  const sql = sqlOver(db);
  const execRaw = (ddl: string): void => { db.exec(ddl); };
  execRaw(WORKSPACE_IDENTITY_DDL);
  initWorkspaceActorTable(execRaw);
  initAgentConfigTable(execRaw);
  initCodemodeStateTable(execRaw);
  initScaffoldTables(execRaw);
  const workspaceId = crypto.randomUUID();
  void sql`INSERT INTO workspace_identity (id, name) VALUES (${workspaceId}, 'seeded')`;
  const directory = new WorkspaceActorDirectory(sql, { workspaceId, ownerUserId: '' });
  const template = createTestRuntime().rt;
  return {
    sql, directory,
    main: directory.createMain({ name: 'seeded' }),
    actorRuntime: (handle, name) => {
      const plane = createMemoryVfs().vfs;
      return {
        ...template,
        actor: handle,
        storage: { vfs: plane, sql, execRaw, transactionSync: (write) => db.transaction(write)() },
        agentStateVfs: plane,
        identity: scaffoldIdentity(name, plane, sql, handle.actorId),
      };
    },
  };
}

/** A parent whose loop really is at v1, written through the production seed. */
async function parentAtV1(fx: Fixture): Promise<AgentRuntime> {
  const parent = fx.actorRuntime(fx.main, 'main');
  await seedActorLoop(parent, null, { kind: 'builtin' });
  const vfs = parent.agentStateVfs ?? parent.storage.vfs;
  await vfs.writeFile(`${parent.identity.scaffold.path}.v1`, PARENT_V1);
  void fx.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status, parent_version)
    VALUES (${parent.actor.actorId}, 1, ${Date.now()}, 'promoted in test', 'current', 0)`;
  void fx.sql`UPDATE scaffold_versions SET status = 'historical'
    WHERE actor_id = ${parent.actor.actorId} AND version = 0`;
  await parent.identity.scaffold.write(PARENT_V1);
  return parent;
}

describe('seedActorLoop', () => {
  test('per-kind defaults are the ones the design settled on', () => {
    expect(defaultLoopOrigin('head')).toEqual({ kind: 'inherit' });
    expect(defaultLoopOrigin('head')).toEqual({ kind: 'inherit' });
    expect(defaultLoopOrigin('branch')).toEqual({ kind: 'inherit' });
    expect(defaultLoopOrigin('subordinate')).toEqual({ kind: 'builtin' });
    expect(defaultLoopOrigin('main')).toEqual({ kind: 'builtin' });
  });

  test('builtin seeds v0 with the shipped source and points at it', async () => {
    const fx = build();
    const child = fx.directory.create({ parent: fx.main, name: 'hire', creationId: 'c1', kind: 'subordinate', lifetime: 'durable' });
    const rt = fx.actorRuntime(child, 'hire');
    const seeded = await seedActorLoop(rt, null, { kind: 'builtin' });
    expect(seeded.version).toBe(0);
    expect(getCurrentScaffoldVersion(fx.sql, child)).toBe(0);
    expect(await rt.identity.scaffold.read()).toBe(INITIAL_SCAFFOLD_SOURCE);
  });

  test('inherit copies the parent CURRENT version bytes as the child v1 and records the lineage', async () => {
    const fx = build();
    const parent = await parentAtV1(fx);
    const child = fx.directory.create({ parent: fx.main, name: 'exp:head-1', creationId: 'c2', kind: 'head', lifetime: 'task' });
    const rt = fx.actorRuntime(child, 'head-1');

    const seeded = await seedActorLoop(rt, parent, defaultLoopOrigin('head'));
    expect(seeded.version).toBe(1);
    expect(getCurrentScaffoldVersion(fx.sql, child)).toBe(1);
    // The bytes are the parent's promoted loop, not the bootstrap one.
    expect(await rt.identity.scaffold.read()).toBe(PARENT_V1);
    const versioned = rt.agentStateVfs ?? rt.storage.vfs;
    expect(await versioned.readFile(`${rt.identity.scaffold.path}.v1`, { encoding: 'utf8' })).toBe(PARENT_V1);
    // Lineage is recorded, so the child's evolution has a parent to diff against.
    const row = fx.sql<{ parent_version: number | null; rationale: string }>`
      SELECT parent_version, rationale FROM scaffold_versions
      WHERE actor_id = ${child.actorId} AND version = 1`[0];
    expect(row?.parent_version).toBe(1);
    expect(row?.rationale).toContain(parent.actor.actorId);
  });

  test('a later parent promotion does not move a child that already inherited', async () => {
    const fx = build();
    const parent = await parentAtV1(fx);
    const child = fx.directory.create({ parent: fx.main, name: 'exp:node-1', creationId: 'c3', kind: 'head', lifetime: 'task' });
    const rt = fx.actorRuntime(child, 'node-1');
    await seedActorLoop(rt, parent, defaultLoopOrigin('head'));

    // The parent promotes v2 after the child was seeded.
    const parentVfs = parent.agentStateVfs ?? parent.storage.vfs;
    await parentVfs.writeFile(`${parent.identity.scaffold.path}.v2`, PARENT_V2);
    void fx.sql`UPDATE scaffold_versions SET status = 'historical'
      WHERE actor_id = ${parent.actor.actorId} AND status = 'current'`;
    void fx.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status, parent_version)
      VALUES (${parent.actor.actorId}, 2, ${Date.now()}, 'promoted again', 'current', 1)`;

    expect(getCurrentScaffoldVersion(fx.sql, parent.actor)).toBe(2);
    // The pointer is PER ACTOR: the child still runs the bytes it was seeded with.
    expect(getCurrentScaffoldVersion(fx.sql, child)).toBe(1);
    expect(await rt.identity.scaffold.read()).toBe(PARENT_V1);
  });

  test('seeding is once-only: a re-acquired actor keeps the pointer it evolved', async () => {
    const fx = build();
    const parent = await parentAtV1(fx);
    const child = fx.directory.create({ parent: fx.main, name: 'exp:head-2', creationId: 'c4', kind: 'head', lifetime: 'task' });
    const rt = fx.actorRuntime(child, 'head-2');
    await seedActorLoop(rt, parent, { kind: 'inherit' });

    // The child evolves its own v2 and promotes it.
    const childVfs = rt.agentStateVfs ?? rt.storage.vfs;
    const own = '// the child own loop\nasync function* run() {}\n';
    await childVfs.writeFile(`${rt.identity.scaffold.path}.v2`, own);
    void fx.sql`UPDATE scaffold_versions SET status = 'historical'
      WHERE actor_id = ${child.actorId} AND status = 'current'`;
    void fx.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status, parent_version)
      VALUES (${child.actorId}, 2, ${Date.now()}, 'the child own', 'current', 1)`;

    const again = await seedActorLoop(rt, parent, { kind: 'inherit' });
    expect(again.version).toBe(2);
    expect(getCurrentScaffoldVersion(fx.sql, child)).toBe(2);
    // And a re-seed with a parent that is no longer hosted is still a no-op,
    // which is what a cold activation resuming a child depends on.
    const cold = await seedActorLoop(rt, null, { kind: 'inherit' });
    expect(cold.version).toBe(2);
  });

  test('a named version the parent retains is copied; one it does not is refused', async () => {
    const fx = build();
    const parent = await parentAtV1(fx);
    const named = fx.directory.create({ parent: fx.main, name: 'exp:head-3', creationId: 'c5', kind: 'head', lifetime: 'task' });
    const namedRt = fx.actorRuntime(named, 'head-3');
    const seeded = await seedActorLoop(namedRt, parent, { kind: 'version', version: 1 });
    expect(seeded.version).toBe(1);
    expect(await namedRt.identity.scaffold.read()).toBe(PARENT_V1);

    const missing = fx.directory.create({ parent: fx.main, name: 'exp:head-4', creationId: 'c6', kind: 'head', lifetime: 'task' });
    const missingRt = fx.actorRuntime(missing, 'head-4');
    await expect(seedActorLoop(missingRt, parent, { kind: 'version', version: 9 }))
      .rejects.toThrow(/retains no version 9/);
    // Refused BEFORE any row or byte landed.
    expect(getCurrentScaffoldVersion(fx.sql, missing)).toBeNull();
  });

  test('inheriting with no parent runtime is refused rather than silently starting fresh', async () => {
    const fx = build();
    const child = fx.directory.create({ parent: fx.main, name: 'exp:head-5', creationId: 'c7', kind: 'head', lifetime: 'task' });
    const rt = fx.actorRuntime(child, 'head-5');
    await expect(seedActorLoop(rt, null, { kind: 'inherit' })).rejects.toThrow(/needs the parent actor/);
    expect(getCurrentScaffoldVersion(fx.sql, child)).toBeNull();
  });
});
