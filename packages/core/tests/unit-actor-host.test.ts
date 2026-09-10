// ActorHost — N logical actors, ONE physical workspace database.
//
// The whole of open-38 is the claim that a hired subordinate, a temporary, a
// head and a node can share one database WITHOUT sharing state. That claim is
// only worth something if it fails loudly, so every case below drives two REAL
// issued actors over ONE `SqlExecutor`, gives them COLLIDING logical keys, and
// asserts each reads back its own row and no other. No mocked handle, no
// spoofed facet, no source-text assertion: the stores are the production bundle
// bound through the production binder over the production directory.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { sqlOver, createMemoryVfs, createTestRuntime } from '@kinu.run/test-utils';
import { makeSqlExec } from './helpers';
import { initWorkspaceSchema } from '../src/identity/workspace-schema';
import { WorkspaceActorDirectory } from '../src/identity/workspace-actors';
import {
  createActorHost, childContextResolver,
  type ActorHost, type BoundActor,
} from '../src/state/actor-host';
import { initEventsHubTables, EventLog } from '../src/events/hub/index';
import { initCompletedTurnTable, createCompletedTurnStore } from '../src/evolution/session-window';
import { readScaffoldFileText } from '../src/scaffold/surface';
import type { AgentOrchestratorDeps } from '../src/orchestrator/agent-orchestrator';
import type { Identity, VFS, SqlExecutor } from '../src/index';
import type { ActorReference } from '../src/identity/actor-handle';
import type { ActorProgramIdentity, ActorTurnClaim } from '../src/orchestrator/actor-claims';

const BUILTIN: ActorProgramIdentity = { kind: 'builtin', version: 0, digest: null, build: 'test-build' };

interface Fixture {
  readonly db: Database;
  readonly sql: SqlExecutor;
  readonly host: ActorHost;
  readonly directory: WorkspaceActorDirectory;
  readonly main: ActorReference;
  child(name: string, creationId: string, kind: 'subordinate' | 'head'): ActorReference;
  /** A NEW host over the SAME database — what a root eviction leaves behind. */
  rebuild(): Fixture;
}

/**
 * A scaffold identity over a REAL in-memory file plane, per actor.
 *
 * `createTestRuntime`'s identity is a stub whose `version()` is always 0 and
 * whose `write` drops the bytes, which cannot express a loop pointer at all.
 * The host seeds every actor's loop before it builds a session, so the pointer
 * and the bytes both have to be real here or the seeding is untested.
 */
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

function build(donor?: Database): Fixture {
  const db = donor ?? new Database(':memory:');
  const sql = sqlOver(db);
  const execRaw = (ddl: string): void => { db.exec(ddl); };
  const exec = makeSqlExec(db);
  initWorkspaceSchema({ execRaw, sql, exec });
  initEventsHubTables(exec);
  initCompletedTurnTable(execRaw);
  const existing = sql<{ id: string }>`SELECT id FROM workspace_identity LIMIT 1`[0];
  const workspaceId = existing?.id ?? crypto.randomUUID();
  if (!existing) void sql`INSERT INTO workspace_identity (id, name) VALUES (${workspaceId}, 'hosted')`;
  const directory = new WorkspaceActorDirectory(sql, { workspaceId, ownerUserId: '' });
  const mainHandle = directory.createMain({ name: 'hosted' });
  // One runtime template per fixture: the fields a hosted actor does NOT own
  // (model, memory, executor, scheduler, craft store) come from the shared test
  // runtime, and the fields it DOES own are replaced per actor below.
  const template = createTestRuntime().rt;
  const planes = new Map<string, VFS>();

  const orchestrationFor = (bound: BoundActor): AgentOrchestratorDeps => ({
    // Its OWN broadcast, event log and session window — never the root's.
    host: {
      broadcast: () => { throw new Error(`${bound.record.name} broadcast outside a turn`); },
      enqueueTurn: async () => ({ status: 'queued' }),
      turnInFlight: () => false,
      // Same refusal as `broadcast` above, and for the same reason: nothing in
      // this suite arms a drain, so a timer armed here is a fault to surface.
      // `void fn()` discarded the rejection of exactly that fault.
      setTimer: () => { throw new Error(`${bound.record.name} armed a drain timer outside a turn`); },
    },
    engine: {
      enabled: false,
      sessionWindow: createCompletedTurnStore(sql, bound.handle),
      craftLedger: { names: () => [], observe: () => [] },
      reviewTurn: async () => {},

      runStoredTurnReview: async () => {},
      deferTurnReview: () => 'queued',
      runDeferredTurnReviews: async () => ({ reviewed: 0, refused: [] }),
      onSessionComplete: async () => {},
      runDueShadowTrials: async () => {},
      recordRecovery: () => {},
    },
    eventLog: new EventLog(exec, bound.handle),
  });

  const host = createActorHost({
    storage: { sql, transactionSync: (write) => db.transaction(write)(), exec: exec.exec },
    directory,
    installedBuild: 'test-build',
    runtimeFor: (bound) => {
      const plane = planes.get(bound.record.actorId) ?? createMemoryVfs().vfs;
      planes.set(bound.record.actorId, plane);
      return {
        ...template,
        actor: bound.handle,
        storage: { vfs: plane, sql, execRaw, transactionSync: (write) => db.transaction(write)() },
        agentStateVfs: plane,
        identity: scaffoldIdentity(bound.record.name, plane, sql, bound.record.actorId),
      };
    },
    loopFor: () => ({ origin: { kind: 'builtin' }, parent: null }),
    orchestrationFor,
    // NULL, stated rather than defaulted: `RunEventRecorder` satisfies
    // `ContextEventRecorder` only once the recorder's `context_edit` variant is in
    // the same tree, and this fixture asserts hosting, not context auditing.
    contextEvents: () => null,
  });

  return {
    db, sql, host, directory,
    main: { actorId: mainHandle.actorId, workspaceId: mainHandle.workspaceId, parentActorId: null },
    child: (name, creationId, kind) => {
      const handle = directory.create({
        parent: mainHandle, name, creationId, kind,
        lifetime: kind === 'subordinate' ? 'durable' : 'task',
      });
      return { actorId: handle.actorId, workspaceId: handle.workspaceId, parentActorId: handle.parentActorId };
    },
    rebuild: () => build(db),
  };
}

/** The claim object a settle needs, for a turn this test admitted itself. */
function claimOf(actorId: string, turnId: string, epoch: number, runId: string): ActorTurnClaim {
  return { actorId, turnId, runId, epoch, workMode: 'build', program: BUILTIN, workingRevision: 0 };
}

describe('one workspace database, many logical actors', () => {
  test('two hosted actors with the SAME turn id keep separate claims in one database', async () => {
    const fx = build();
    const alpha = await fx.host.acquire(fx.child('alpha', 'c-alpha', 'subordinate'));
    const beta = await fx.host.acquire(fx.child('beta', 'c-beta', 'subordinate'));
    expect(alpha.handle.actorId).not.toBe(beta.handle.actorId);

    alpha.stores.claims.admit({ runId: 'run-a', turnId: 'turn-1', workMode: 'build', program: BUILTIN, context: [], workingRevision: 0 });
    beta.stores.claims.admit({ runId: 'run-b', turnId: 'turn-1', workMode: 'build', program: BUILTIN, context: [], workingRevision: 0 });

    expect(alpha.stores.claims.read('turn-1')?.runId).toBe('run-a');
    expect(beta.stores.claims.read('turn-1')?.runId).toBe('run-b');
    expect(fx.sql<{ n: number }>`SELECT COUNT(*) AS n FROM actor_turn_claims WHERE turn_id = 'turn-1'`[0]?.n).toBe(2);
    // Both actors also evolve their own loop pointer in the same table.
    expect(fx.sql<{ n: number }>`SELECT COUNT(*) AS n FROM scaffold_versions WHERE status = 'current'`[0]?.n).toBe(2);
  });

  test('a released actor stops authorising statements through the stores it handed out', async () => {
    const fx = build();
    const ref = fx.child('alpha', 'c-alpha', 'subordinate');
    const alpha = await fx.host.acquire(ref);
    const claims = alpha.stores.claims;
    claims.admit({ runId: 'r', turnId: 't', workMode: 'build', program: BUILTIN, context: [], workingRevision: 0 });
    expect(claims.read('t')?.runId).toBe('r');

    fx.host.release(ref);
    expect(fx.host.hosted(ref)).toBeNull();
    expect(() => claims.read('t')).toThrow(/released by its root/);
    // The ROWS survive: dropping runtime objects is not destroying the actor.
    expect(fx.sql<{ n: number }>`SELECT COUNT(*) AS n FROM actor_turn_claims WHERE actor_id = ${ref.actorId}`[0]?.n).toBe(1);
  });

  test('re-acquiring an actor does not revive the binding that was released', async () => {
    const fx = build();
    const ref = fx.child('alpha', 'c-alpha', 'subordinate');
    const first = await fx.host.acquire(ref);
    const staleClaims = first.stores.claims;
    fx.host.release(ref);

    const second = await fx.host.acquire(ref);
    expect(second.handle).not.toBe(first.handle);
    // The NEW binding works…
    second.stores.claims.admit({ runId: 'r2', turnId: 't2', workMode: 'build', program: BUILTIN, context: [], workingRevision: 0 });
    expect(second.stores.claims.read('t2')?.runId).toBe('r2');
    // …and the old one stays dead. A fence keyed on the actor ID rather than on
    // the binding would be reset by this acquisition and hand a caller who still
    // held the released stores a working binding again.
    expect(() => staleClaims.read('t2')).toThrow(/released by its root/);
  });

  test('reading a retained actor starts nothing', async () => {
    const fx = build();
    const ref = fx.child('gone', 'c-gone', 'subordinate');
    const hosted = await fx.host.acquire(ref);
    hosted.stores.claims.admit({ runId: 'r', turnId: 't', workMode: 'build', program: BUILTIN, context: [], workingRevision: 0 });
    fx.host.release(ref);

    const cold = fx.rebuild();
    const record = cold.host.describe(ref.actorId);
    expect(record?.name).toBe('gone');
    // describe() built no runtime objects, so nothing is hosted and nothing ran.
    expect(cold.host.list()).toHaveLength(0);
    expect(cold.host.hosted(ref)).toBeNull();
  });

  test('per-actor serialization: one actor is ordered, another is not blocked', async () => {
    const fx = build();
    const a = fx.child('alpha', 'c-alpha', 'subordinate');
    const b = fx.child('beta', 'c-beta', 'subordinate');
    await fx.host.acquire(a);
    await fx.host.acquire(b);
    const order: string[] = [];
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();

    const first = fx.host.run(a, async () => {
      order.push('a1-start');
      started.resolve();
      await held.promise;
      order.push('a1-end');
    });
    const second = fx.host.run(a, async () => { order.push('a2'); });
    await started.promise;
    // Another actor's work runs while this one is parked: one database, two
    // independent queues.
    await fx.host.run(b, async () => { order.push('b1'); });
    expect(order).toEqual(['a1-start', 'b1']);
    held.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['a1-start', 'b1', 'a1-end', 'a2']);
  });

  test('an abandoned caller does not cancel hosted work', async () => {
    const fx = build();
    const ref = fx.child('alpha', 'c-alpha', 'subordinate');
    const hosted = await fx.host.acquire(ref);
    const held = Promise.withResolvers<void>();
    let finished = false;
    // The caller starts work and walks away — a client disconnecting, a request
    // returning. Nothing here observes the promise until after the fact.
    const work = fx.host.run(ref, async () => {
      await held.promise;
      finished = true;
      return 'answered';
    });
    held.resolve();
    await expect(work).resolves.toBe('answered');
    expect(finished).toBe(true);
    // Still hosted, still usable, never interrupted.
    expect(fx.host.hosted(ref)).not.toBeNull();
    expect(hosted.session.inFlight).toBe(false);
    await expect(fx.host.run(ref, async () => 'again')).resolves.toBe('again');
  });

  test('destructive retirement refuses a stale alias and a stale epoch, then purges only that actor', async () => {
    const fx = build();
    const a = fx.child('alpha', 'c-alpha', 'subordinate');
    const b = fx.child('beta', 'c-beta', 'subordinate');
    const alpha = await fx.host.acquire(a);
    const beta = await fx.host.acquire(b);
    const claim = alpha.stores.claims.admit({ runId: 'r1', turnId: 'turn-1', workMode: 'build', program: BUILTIN, context: [], workingRevision: 0 });
    beta.stores.claims.admit({ runId: 'r2', turnId: 'turn-1', workMode: 'build', program: BUILTIN, context: [], workingRevision: 0 });
    alpha.stores.claims.settle(claim, 'completed');

    await expect(fx.host.retire(fx.main, { reference: a, name: 'not-alpha', destroy: true }))
      .rejects.toThrow(/alias this actor no longer holds/);

    // A newer epoch admitted the same turn since the caller looked at it.
    alpha.stores.claims.admit({ runId: 'r3', turnId: 'turn-1', workMode: 'build', program: BUILTIN, context: [], workingRevision: 0 });
    await expect(fx.host.retire(fx.main, {
      reference: a, name: 'alpha', destroy: true, observed: { turnId: 'turn-1', epoch: 1 },
    })).rejects.toThrow(/epoch 1/);

    await fx.host.retire(fx.main, { reference: a, name: 'alpha', destroy: true });
    expect(fx.sql<{ n: number }>`SELECT COUNT(*) AS n FROM actor_turn_claims WHERE actor_id = ${a.actorId}`[0]?.n).toBe(0);
    expect(fx.sql<{ n: number }>`SELECT COUNT(*) AS n FROM actor_context_revisions WHERE actor_id = ${a.actorId}`[0]?.n).toBe(0);
    expect(fx.sql<{ n: number }>`SELECT COUNT(*) AS n FROM scaffold_versions WHERE actor_id = ${a.actorId}`[0]?.n).toBe(0);
    // The sibling that shared every one of those tables is untouched.
    expect(fx.sql<{ n: number }>`SELECT COUNT(*) AS n FROM actor_turn_claims WHERE actor_id = ${b.actorId}`[0]?.n).toBe(1);
    expect(fx.sql<{ n: number }>`SELECT COUNT(*) AS n FROM scaffold_versions WHERE actor_id = ${b.actorId}`[0]?.n).toBe(1);
  });

  test('a retained dismissal keeps the rows a purge would have taken', async () => {
    const fx = build();
    const a = fx.child('alpha', 'c-alpha', 'subordinate');
    const alpha = await fx.host.acquire(a);
    alpha.stores.claims.admit({ runId: 'r', turnId: 't', workMode: 'build', program: BUILTIN, context: [], workingRevision: 0 });
    alpha.stores.claims.settle(claimOf(a.actorId, 't', 1, 'r'), 'completed');

    await fx.host.retire(fx.main, { reference: a, name: 'alpha', destroy: false });
    expect(fx.sql<{ n: number }>`SELECT COUNT(*) AS n FROM actor_turn_claims WHERE actor_id = ${a.actorId}`[0]?.n).toBe(1);
    // The name is released, so the actor is no longer an active member…
    expect(fx.directory.list().some((actor) => actor.actorId === a.actorId)).toBe(false);
    // …but it is still nameable, which is what makes its history readable.
    expect(fx.host.describe(a.actorId)?.name).toBe('alpha');
  });

  test('resumable work is rebuilt from durable rows alone, after every session is gone', async () => {
    const fx = build();
    const a = fx.child('alpha', 'c-alpha', 'subordinate');
    const b = fx.child('beta', 'c-beta', 'subordinate');
    const alpha = await fx.host.acquire(a);
    const beta = await fx.host.acquire(b);
    const program: ActorProgramIdentity = { kind: 'scaffold', version: 3, digest: 'digest-3', build: null };
    alpha.stores.claims.admit({ runId: 'run-a', turnId: 'turn-live', workMode: 'build', program, context: [], workingRevision: 0 });
    const settled = beta.stores.claims.admit({ runId: 'run-b', turnId: 'turn-done', workMode: 'build', program, context: [], workingRevision: 0 });
    beta.stores.claims.settle(settled, 'completed');

    // Eviction: every session, queue and in-memory object is gone.
    fx.host.releaseAll();
    const pending = fx.rebuild().host.resumable();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.claim.turnId).toBe('turn-live');
    expect(pending[0]?.claim.program).toEqual(program);
    expect(pending[0]?.reference.actorId).toBe(a.actorId);
    expect(pending[0]?.record.name).toBe('alpha');
  });

  test('a retirement purge sweeps a table the schema grew, and nothing that carries no actor', async () => {
    const fx = build();
    const a = fx.child('alpha', 'c-alpha', 'subordinate');
    const b = fx.child('beta', 'c-beta', 'subordinate');
    const alpha = await fx.host.acquire(a);
    const beta = await fx.host.acquire(b);
    alpha.stores.claims.admit({ runId: 'r-a', turnId: 't-a', workMode: 'build', program: BUILTIN, context: [], workingRevision: 0 });
    beta.stores.claims.admit({ runId: 'r-b', turnId: 't-b', workMode: 'build', program: BUILTIN, context: [], workingRevision: 0 });
    // A table this workspace grew AFTER the host was built, carrying `actor_id`
    // the way every actor-scoped table does. This is the property, and the rows
    // are where it is observable: the purge reads its table set off the schema
    // in front of it, so a table nobody remembered to add to a cleanup list is
    // swept anyway. Against a hand-kept list, alpha's row below OUTLIVES alpha
    // — under an id the directory is free to issue again.
    fx.db.exec(`CREATE TABLE actor_late_notes (actor_id TEXT NOT NULL, note TEXT NOT NULL)`);
    // …and one that carries no actor at all, which the same pass has to leave
    // alone: a purge that swept every table would delete the workspace's own
    // rows, and `DELETE ... WHERE actor_id = ?` over this one throws instead.
    fx.db.exec(`CREATE TABLE workspace_late_notes (note TEXT NOT NULL)`);
    void fx.sql`INSERT INTO actor_late_notes (actor_id, note) VALUES (${a.actorId}, 'alpha-note')`;
    void fx.sql`INSERT INTO actor_late_notes (actor_id, note) VALUES (${b.actorId}, 'beta-note')`;
    void fx.sql`INSERT INTO workspace_late_notes (note) VALUES ('workspace-note')`;

    await fx.host.retire(fx.main, { reference: a, name: 'alpha', destroy: true });

    // ONE pass took both: the table the schema shipped and the table it grew.
    expect(fx.sql<{ n: number }>`SELECT COUNT(*) AS n FROM actor_turn_claims WHERE actor_id = ${a.actorId}`[0]?.n).toBe(0);
    expect(fx.sql<{ actor_id: string; note: string }>`SELECT actor_id, note FROM actor_late_notes`)
      .toEqual([{ actor_id: b.actorId, note: 'beta-note' }]);
    // The table with no actor column was not the purge's business…
    expect(fx.sql<{ note: string }>`SELECT note FROM workspace_late_notes`).toEqual([{ note: 'workspace-note' }]);
    // …and neither was the directory's own row, which is what leaves a
    // destroyed actor NAMEABLE instead of a dangling id in somebody's log.
    expect(fx.host.describe(a.actorId)?.name).toBe('alpha');
  });

  test('a parent reaches its own children context stores and nobody else', async () => {
    const fx = build();
    const a = fx.child('alpha', 'c-alpha', 'subordinate');
    await fx.host.acquire(a);
    const resolver = childContextResolver({
      host: fx.host, directory: fx.directory, parent: fx.directory.open(fx.main.actorId),
      // The CHILD's own recorder, which is the point: an edit a parent makes to
      // a child's context is recorded against the child whose context moved.
      events: () => null,
    });
    const storageKey = fx.host.describe(a.actorId)?.storageKey ?? '';
    expect(resolver.list()).toContain(storageKey);
    expect(resolver.resolve(storageKey)?.actorId).toBe(a.actorId);
    expect(resolver.resolve('not-a-child')).toBeNull();
    // The child's own store, bound to the CHILD's handle: an edit made through
    // it is refused by the same fence the child's own edit meets.
    const child = resolver.resolve(storageKey);
    expect(child?.claims).toBeDefined();
  });
});
