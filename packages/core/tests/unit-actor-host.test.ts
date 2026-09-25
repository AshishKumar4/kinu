// ActorHost: N logical actors over one physical database, without sharing state.
// Two real issued actors over one `SqlExecutor` with colliding keys each read back
// only their own rows, through the production binder and directory.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { sqlOver, createMemoryVfs, createTestRuntime, unobservedSpend } from '@kinu.run/test-utils';
import { makeSqlExec } from './helpers';
import { initWorkspaceSchema } from '../src/state/workspace-schema';
import { WorkspaceActorDirectory } from '../src/identity/workspace-actors';
import {
  createActorHost, childContextResolver, recoverActorTurns,
  type ActorHost, type BoundActor,
} from '../src/state/actor-host';
import { initEventsHubTables, EventLog } from '../src/events/hub/index';
import { initCompletedTurnTable } from '../src/evolution/session-window';
import { EvolutionEngine } from '../src/evolution/engine';
import { listRecoveryFindings } from '../src/evolution/recovery';
import { readScaffoldFileText } from '../src/scaffold/surface';
import type { AgentOrchestratorDeps } from '../src/orchestrator/agent-orchestrator';
import type { AgentRuntime, Identity, VFS, SqlExecutor } from '../src/index';
import { actorReferenceOf, type ActorReference } from '../src/identity/actor-handle';
import type { ActorProgramIdentity, ActorTurnClaim } from '../src/orchestrator/actor-claims';
import type { ContextSelection } from '../src/session/context';
import { agentArtifactDirectory } from '../src/vfs/agent-home';
import { sha256Hex } from '../src/safety/argument-digest';
import { createRecordingLogger, setDiagnosticsSink } from '../src/obs/index';

const BUILTIN: ActorProgramIdentity = { kind: 'builtin', version: 0, digest: null, build: 'test-build' };

interface Fixture {
  readonly db: Database;
  readonly sql: SqlExecutor;
  readonly host: ActorHost;
  readonly directory: WorkspaceActorDirectory;
  readonly main: ActorReference;
  child(name: string, creationId: string, kind: 'subordinate' | 'head'): ActorReference;
  /** A new host over the same database, as a root eviction leaves. */
  rebuild(): Fixture;
}

/** A real per-actor scaffold identity, since the host seeds every actor's loop pointer and bytes. */
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

function build(donor?: Database, unreadableActor?: string, automatic = false): Fixture {
  const db = donor ?? new Database(':memory:');
  const sql = sqlOver(db);
  const execRaw = (ddl: string): void => { db.exec(ddl); };

  const exec = makeSqlExec(db);
  initWorkspaceSchema({ execRaw, sql, exec, transactionSync: (write) => db.transaction(write)() });
  initEventsHubTables(exec);
  initCompletedTurnTable(execRaw);
  const existing = sql<{ id: string }>`SELECT id FROM workspace_identity LIMIT 1`[0];
  const workspaceId = existing?.id ?? crypto.randomUUID();

  if (!existing) void sql`INSERT INTO workspace_identity (id, name) VALUES (${workspaceId}, 'hosted')`;
  const directory = new WorkspaceActorDirectory(sql, { workspaceId, ownerUserId: '' });
  const mainHandle = directory.createMain({ name: 'hosted' });
  // Shared runtime fields come from the template; actor-owned fields are replaced below.
  const template = createTestRuntime().rt;
  const planes = new Map<string, VFS>();

  const orchestrationFor = (bound: BoundActor & { runtime: AgentRuntime }): AgentOrchestratorDeps => ({
    // Its own broadcast, event log and session window.
    host: {
      broadcast: () => { throw new Error(`${bound.record.name} broadcast outside a turn`); },
      enqueueTurn: async () => ({ status: 'queued' }),
      turnInFlight: () => false,
      // Nothing here arms a drain, so an armed timer is a fault to surface.
      setTimer: () => { throw new Error(`${bound.record.name} armed a drain timer outside a turn`); },
    },
    engine: new EvolutionEngine(bound.runtime, bound.stores.history, { reportModelCall: unobservedSpend, enabled: automatic }),
    eventLog: new EventLog(exec, bound.handle),
  });

  // Memoized per actor so the session store and runtime address the same bytes.
  const planeFor = (actorId: string): VFS => {
    const plane = planes.get(actorId) ?? createMemoryVfs().vfs;
    planes.set(actorId, plane);

    return plane;
  };

  const host = createActorHost({
    storage: {
      sql,
      transactionSync: (write) => db.transaction(write)(),
      exec: (query, ...bindings) => exec.exec(query, ...bindings),
    },
    directory,
    installedBuild: 'test-build',
    filesFor: async (bound) => ({
      vfs: planeFor(bound.record.actorId),
      artifactDirectory: agentArtifactDirectory(`/actors/${bound.record.actorId}`),
    }),
    runtimeFor: (bound) => {
      if (bound.record.name === unreadableActor) throw new Error('actor file plane is unreadable');
      const plane = planeFor(bound.record.actorId);

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
    // Null: this fixture asserts hosting, not context auditing.
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
    rebuild: () => build(db, unreadableActor, automatic),
  };
}

/** Initialized on first use: a silent actor has no context row yet. */
function contextOf(actor: BoundActor): ContextSelection {
  return actor.stores.history.context.selected() ?? actor.stores.history.context.initialize();
}

/** The claim object a settle needs, for a turn this test admitted itself. */
interface ClaimSeed {
  actorId: string;
  turnId: string;
  epoch: number;
  runId: string;
  context: ContextSelection;
}

function claimOf({ actorId, turnId, epoch, runId, context }: ClaimSeed): ActorTurnClaim {
  return { actorId, turnId, runId, epoch, workMode: 'build', program: BUILTIN,
    workingRevision: context.revision, workingContextId: context.contextId };
}

describe('one workspace database, many logical actors', () => {
  for (const policy of [
    { automatic: true, mode: 'build', findings: 1, rootTurns: 2 },
    { automatic: true, mode: 'plan', findings: 0, rootTurns: 0 },
    { automatic: false, mode: 'build', findings: 0, rootTurns: 0 },
    { automatic: false, mode: 'plan', findings: 0, rootTurns: 0 },
  ] as const) {
    test(`acquired actors keep step and turn learning separate: auto=${policy.automatic}, mode=${policy.mode}`, async () => {
      const fx = build(undefined, undefined, policy.automatic);
      const main = await fx.host.acquire(fx.main);

      const temporary = fx.directory.create({
        parent: main.handle, name: 'temporary', kind: 'subordinate', lifetime: 'task', creationId: 'temporary',
      });

      const actors = [
        { reference: fx.main, turns: policy.rootTurns },
        { reference: fx.child('hire', 'hire', 'subordinate'), turns: 0 },
        { reference: actorReferenceOf(temporary), turns: 0 },
      ];

      try {
        for (const expected of actors) {
          const actor = await fx.host.acquire(expected.reference);

          for (const index of [0, 1]) {
            const lease = actor.session.beginTurn({ runId: `run-${index}`, turnId: `turn-${index}` }, policy.mode, index);
            const extension = actor.session.orchestrator.turnExtension;

            if (extension.onToolResult === undefined) throw new Error('the acquired actor has no step observation');

            for (let failures = 0; failures < 3; failures++) {
              await extension.onToolResult({ toolName: 'shell', args: { command: 'bad' }, result: 'failed', success: false, reason: null });
            }

            await extension.onToolResult({ toolName: 'shell', args: { command: 'corrected' }, result: 'done', success: true });
            actor.session.orchestrator.recordTurn({
              userMessage: `assignment ${index}`, assistantResponse: 'done', toolCalls: [],
              steps: 1, durationMs: 1, feedback: null, hadError: false, turnId: `turn-${index}`,
            }, 'conversation');
            actor.session.finishTurn(lease);
            await actor.session.orchestrator.runDueSessionEvolution();
          }

          expect(actor.session.orchestrator.sessionTurnIndex).toBe(expected.turns);
          expect(listRecoveryFindings(actor.runtime.storage.sql, actor.handle)).toHaveLength(policy.findings);
        }

        fx.host.releaseAll();
        const reopened = fx.rebuild();

        for (const expected of actors) {
          expect((await reopened.host.acquire(expected.reference)).session.orchestrator.sessionTurnIndex).toBe(expected.turns);
        }

        reopened.host.releaseAll();
      } finally {
        fx.host.releaseAll();
        fx.db.close();
      }
    });
  }

  test('two hosted actors with the SAME turn id keep separate claims in one database', async () => {
    const fx = build();
    const alpha = await fx.host.acquire(fx.child('alpha', 'c-alpha', 'subordinate'));
    const beta = await fx.host.acquire(fx.child('beta', 'c-beta', 'subordinate'));
    expect(alpha.handle.actorId).not.toBe(beta.handle.actorId);

    await alpha.stores.claims.admit({ runId: 'run-a', turnId: 'turn-1', workMode: 'build', program: BUILTIN, context: contextOf(alpha) });
    await beta.stores.claims.admit({ runId: 'run-b', turnId: 'turn-1', workMode: 'build', program: BUILTIN, context: contextOf(beta) });

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
    await claims.admit({ runId: 'r', turnId: 't', workMode: 'build', program: BUILTIN, context: contextOf(alpha) });
    expect(claims.read('t')?.runId).toBe('r');

    fx.host.release(ref);
    expect(fx.host.hosted(ref)).toBeNull();
    expect(() => claims.read('t')).toThrow(/released by its root/);
    // The rows survive releasing the runtime objects.
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
    // The new binding works…
    await second.stores.claims.admit({ runId: 'r2', turnId: 't2', workMode: 'build', program: BUILTIN, context: contextOf(second) });
    expect(second.stores.claims.read('t2')?.runId).toBe('r2');
    // …and the old one stays dead: the fence is keyed on the binding, not the actor id.
    expect(() => staleClaims.read('t2')).toThrow(/released by its root/);
  });

  test('reading a retained actor starts nothing', async () => {
    const fx = build();
    const ref = fx.child('gone', 'c-gone', 'subordinate');
    const hosted = await fx.host.acquire(ref);
    await hosted.stores.claims.admit({ runId: 'r', turnId: 't', workMode: 'build', program: BUILTIN, context: contextOf(hosted) });
    fx.host.release(ref);

    const cold = fx.rebuild();
    const record = cold.host.describe(ref.actorId);
    expect(record?.name).toBe('gone');
    // describe() built no runtime objects.
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
    // Another actor's work runs while this one is parked.
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

    // The caller starts work and walks away.
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
    const claim = await alpha.stores.claims.admit({ runId: 'r1', turnId: 'turn-1', workMode: 'build', program: BUILTIN, context: contextOf(alpha) });
    await beta.stores.claims.admit({ runId: 'r2', turnId: 'turn-1', workMode: 'build', program: BUILTIN, context: contextOf(beta) });
    alpha.stores.claims.settle(claim, 'completed');

    await expect(fx.host.retire(fx.main, { reference: a, name: 'not-alpha', destroy: true, interrupt: true }))
      .rejects.toThrow(/alias this actor no longer holds/);

    // A newer epoch admitted the same turn since the caller looked.
    await alpha.stores.claims.admit({ runId: 'r3', turnId: 'turn-1', workMode: 'build', program: BUILTIN, context: contextOf(alpha) });
    await expect(fx.host.retire(fx.main, {
      reference: a, name: 'alpha', destroy: true, interrupt: true, observed: { turnId: 'turn-1', epoch: 1 },
    })).rejects.toThrow(/epoch 1/);

    await fx.host.retire(fx.main, { reference: a, name: 'alpha', destroy: true, interrupt: true });
    expect(fx.sql<{ n: number }>`SELECT COUNT(*) AS n FROM actor_turn_claims WHERE actor_id = ${a.actorId}`[0]?.n).toBe(0);
    expect(fx.sql<{ n: number }>`SELECT COUNT(*) AS n FROM context_revisions WHERE actor_id = ${a.actorId}`[0]?.n).toBe(0);
    expect(fx.sql<{ n: number }>`SELECT COUNT(*) AS n FROM scaffold_versions WHERE actor_id = ${a.actorId}`[0]?.n).toBe(0);
    // The sibling is untouched.
    expect(fx.sql<{ n: number }>`SELECT COUNT(*) AS n FROM actor_turn_claims WHERE actor_id = ${b.actorId}`[0]?.n).toBe(1);
    expect(fx.sql<{ n: number }>`SELECT COUNT(*) AS n FROM scaffold_versions WHERE actor_id = ${b.actorId}`[0]?.n).toBe(1);
  });

  test('a retained dismissal keeps the rows a purge would have taken', async () => {
    const fx = build();
    const a = fx.child('alpha', 'c-alpha', 'subordinate');
    const alpha = await fx.host.acquire(a);
    await alpha.stores.claims.admit({ runId: 'r', turnId: 't', workMode: 'build', program: BUILTIN, context: contextOf(alpha) });
    alpha.stores.claims.settle(claimOf({ actorId: a.actorId, turnId: 't', epoch: 1, runId: 'r', context: contextOf(alpha) }), 'completed');

    await fx.host.retire(fx.main, { reference: a, name: 'alpha', destroy: false, interrupt: false });
    expect(fx.sql<{ n: number }>`SELECT COUNT(*) AS n FROM actor_turn_claims WHERE actor_id = ${a.actorId}`[0]?.n).toBe(1);
    // The name is released, so the actor is no longer an active member…
    expect(fx.directory.list().some((actor) => actor.actorId === a.actorId)).toBe(false);
    // …but it is still nameable, so its history stays readable.
    expect(fx.host.describe(a.actorId)?.name).toBe('alpha');
  });

  test('resumable work is rebuilt from durable rows alone, after every session is gone', async () => {
    const fx = build();
    const a = fx.child('alpha', 'c-alpha', 'subordinate');
    const b = fx.child('beta', 'c-beta', 'subordinate');
    const alpha = await fx.host.acquire(a);
    const beta = await fx.host.acquire(b);
    const program: ActorProgramIdentity = { kind: 'scaffold', version: 3, digest: 'digest-3', build: null };
    await alpha.stores.claims.admit({ runId: 'run-a', turnId: 'turn-live', workMode: 'build', program, context: contextOf(alpha) });
    const settled = await beta.stores.claims.admit({ runId: 'run-b', turnId: 'turn-done', workMode: 'build', program, context: contextOf(beta) });
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

  test('recovery retains a verified claim as owed without claiming execution resumed', async () => {
    const fx = build();
    const actor = await fx.host.acquire(fx.child('alpha', 'c-alpha', 'subordinate'));
    const source = 'export default async function main() { return "retained"; }';
    await actor.runtime.storage.vfs.writeFile(`${actor.runtime.identity.scaffold.path}.v1`, source);

    const admitted = await actor.stores.claims.admit({
      runId: 'run-a', turnId: 'turn-a', workMode: 'build', context: contextOf(actor),
      program: { kind: 'scaffold', version: 1, digest: sha256Hex(source), build: null },
    });

    const recovered = await recoverActorTurns(fx.host);
    expect(recovered).toEqual({ verified: ['turn-a'], refused: [], failed: [], unreadable: [], active: [] });
    expect(actor.stores.claims.read('turn-a')).toMatchObject({ status: 'admitted', outcome: null, epoch: admitted.epoch });
    expect(await recoverActorTurns(fx.host)).toEqual(recovered);
    fx.host.releaseAll();
    fx.db.close();
  });

  test('recovery leaves an unreadable actor claim owed across repeated opens', async () => {
    const fx = build();
    const actor = await fx.host.acquire(fx.child('alpha', 'c-alpha', 'subordinate'));
    await actor.stores.claims.admit({ runId: 'run-a', turnId: 'turn-a', workMode: 'build', context: contextOf(actor), program: BUILTIN });
    const cold = build(fx.db, 'alpha');

    const first = await recoverActorTurns(cold.host);
    expect(first).toEqual({ verified: [], refused: [], failed: [], unreadable: ['turn-a'], active: [] });
    expect(await recoverActorTurns(cold.host)).toEqual(first);
    expect(actor.stores.claims.read('turn-a')).toMatchObject({ status: 'admitted', outcome: null, epoch: 1 });
    cold.host.releaseAll();
    fx.host.releaseAll();
    fx.db.close();
  });

  test('recovery refuses changed program bytes once but does not settle a live actor', async () => {
    const fx = build();
    const actor = await fx.host.acquire(fx.child('alpha', 'c-alpha', 'subordinate'));
    await actor.stores.claims.admit({
      runId: 'run-a', turnId: 'turn-a', workMode: 'build', context: contextOf(actor),
      program: { kind: 'scaffold', version: 1, digest: sha256Hex('missing'), build: null },
    });
    const lease = actor.session.beginTurn({ runId: 'run-a', turnId: 'turn-a' }, 'build', 0);
    expect(await recoverActorTurns(fx.host)).toEqual({ verified: [], refused: [], failed: [], unreadable: [], active: ['turn-a'] });
    expect(actor.stores.claims.read('turn-a')?.status).toBe('admitted');
    actor.session.finishTurn(lease);

    expect(await recoverActorTurns(fx.host)).toEqual({ verified: [], refused: ['turn-a'], failed: [], unreadable: [], active: [] });
    expect(actor.stores.claims.read('turn-a')).toMatchObject({ status: 'settled', outcome: 'indeterminate', epoch: 1 });
    expect(await recoverActorTurns(fx.host)).toEqual({ verified: [], refused: [], failed: [], unreadable: [], active: [] });
    fx.host.releaseAll();
    fx.db.close();
  });

  test('recovery rechecks live ownership after awaited program verification', async () => {
    const fx = build();
    const actor = await fx.host.acquire(fx.child('alpha', 'c-alpha', 'subordinate'));
    const path = `${actor.runtime.identity.scaffold.path}.v1`;
    await actor.runtime.storage.vfs.writeFile(path, 'changed source');
    await actor.stores.claims.admit({
      runId: 'run-a', turnId: 'turn-a', workMode: 'build', context: contextOf(actor),
      program: { kind: 'scaffold', version: 1, digest: sha256Hex('expected source'), build: null },
    });
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = actor.runtime.storage.vfs.readFile.bind(actor.runtime.storage.vfs);

    actor.runtime.storage.vfs.readFile = async (file, options) => {
      if (file === path) {
        reading.resolve();
        await release.promise;
      }

      return read(file, options);
    };

    const recovering = recoverActorTurns(fx.host);
    await reading.promise;
    const lease = actor.session.beginTurn({ runId: 'run-a', turnId: 'turn-a' }, 'build', 0);
    release.resolve();
    expect(await recovering).toEqual({ verified: [], refused: [], failed: [], unreadable: [], active: ['turn-a'] });
    expect(actor.stores.claims.read('turn-a')?.status).toBe('admitted');
    actor.session.finishTurn(lease);

    expect(await recoverActorTurns(fx.host)).toEqual({ verified: [], refused: ['turn-a'], failed: [], unreadable: [], active: [] });
    expect(actor.stores.claims.read('turn-a')?.outcome).toBe('indeterminate');
    fx.host.releaseAll();
    fx.db.close();
  });

  test('a claim whose consumed step has lost its list settles error once, and the failure names the request', async () => {
    const fx = build();
    const actor = await fx.host.acquire(fx.child('alpha', 'c-alpha', 'subordinate'));
    const claim = await actor.stores.claims.admit({ runId: 'run-a', turnId: 'turn-a', workMode: 'build', context: contextOf(actor), program: BUILTIN });
    const step = await actor.stores.claims.consume(claim, { index: 0, messages: [{ role: 'user', content: 'go' }] });
    // The row naming the step's list, which no request written before the requests lineage has.
    void fx.sql`DELETE FROM request_renders WHERE actor_id=${claim.actorId} AND request_id=${step.requestId}`;
    const log = createRecordingLogger();
    const restore = setDiagnosticsSink(log);

    try {
      expect(await recoverActorTurns(fx.host)).toEqual({ verified: [], refused: [], failed: ['turn-a'], unreadable: [], active: [] });
      expect(actor.stores.claims.read('turn-a')).toMatchObject({ status: 'settled', outcome: 'error', epoch: claim.epoch });
      // Settled, so the next wake's sweep neither retries it nor logs it again.
      expect(await recoverActorTurns(fx.host)).toEqual({ verified: [], refused: [], failed: [], unreadable: [], active: [] });
      expect(log.emitted.filter((line) => line.event === 'actor.turn_record_unreadable').map(({ code, cause }) => ({ code, cause }))).toEqual([
        { code: 'io', cause: expect.stringContaining(`request ${step.requestId} has no recorded message list`) },
      ]);
    } finally {
      restore();
      fx.host.releaseAll();
      fx.db.close();
    }
  });

  test('a retirement purge sweeps a table the schema grew, and nothing that carries no actor', async () => {
    const fx = build();
    const a = fx.child('alpha', 'c-alpha', 'subordinate');
    const b = fx.child('beta', 'c-beta', 'subordinate');
    const alpha = await fx.host.acquire(a);
    const beta = await fx.host.acquire(b);
    await alpha.stores.claims.admit({ runId: 'r-a', turnId: 't-a', workMode: 'build', program: BUILTIN, context: contextOf(alpha) });
    await beta.stores.claims.admit({ runId: 'r-b', turnId: 't-b', workMode: 'build', program: BUILTIN, context: contextOf(beta) });
    // A table grown after the host was built: the purge reads its table set off the
    // live schema, so it is swept without a hand-kept list.
    fx.db.exec(`CREATE TABLE actor_late_notes (actor_id TEXT NOT NULL, note TEXT NOT NULL)`);
    // …and one with no actor column, which the purge must leave alone.
    fx.db.exec(`CREATE TABLE workspace_late_notes (note TEXT NOT NULL)`);
    void fx.sql`INSERT INTO actor_late_notes (actor_id, note) VALUES (${a.actorId}, 'alpha-note')`;
    void fx.sql`INSERT INTO actor_late_notes (actor_id, note) VALUES (${b.actorId}, 'beta-note')`;
    void fx.sql`INSERT INTO workspace_late_notes (note) VALUES ('workspace-note')`;

    await fx.host.retire(fx.main, { reference: a, name: 'alpha', destroy: true, interrupt: true });

    // One pass took both the shipped and the grown table.
    expect(fx.sql<{ n: number }>`SELECT COUNT(*) AS n FROM actor_turn_claims WHERE actor_id = ${a.actorId}`[0]?.n).toBe(0);
    expect(fx.sql<{ actor_id: string; note: string }>`SELECT actor_id, note FROM actor_late_notes`)
      .toEqual([{ actor_id: b.actorId, note: 'beta-note' }]);
    // The table with no actor column was untouched…
    expect(fx.sql<{ note: string }>`SELECT note FROM workspace_late_notes`).toEqual([{ note: 'workspace-note' }]);
    // …and so was the directory row, keeping the destroyed actor nameable.
    expect(fx.host.describe(a.actorId)?.name).toBe('alpha');
  });

  test('a parent reaches its own children context stores and nobody else', async () => {
    const fx = build();
    const a = fx.child('alpha', 'c-alpha', 'subordinate');
    await fx.host.acquire(a);

    const resolver = childContextResolver({
      host: fx.host, directory: fx.directory, parent: fx.directory.open(fx.main.actorId),
      // The child's own recorder: an edit to a child's context is recorded against the child.
      events: () => null,
    });

    const storageKey = fx.host.describe(a.actorId)?.storageKey ?? '';
    expect(resolver.list()).toContain(storageKey);
    expect(resolver.resolve(storageKey)?.claims.actorId).toBe(a.actorId);
    expect(resolver.resolve('not-a-child')).toBeNull();
    // Bound to the child's handle, so the same fence refuses it.
    const child = resolver.resolve(storageKey);
    expect(child?.claims).toBeDefined();
  });
});
