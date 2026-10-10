import { exists, readText, type VFS, writeText } from '@nimbus-sh/core/vfs/vfs.js';
// ActorHost: N logical actors over one physical database, without sharing state.
// Two real issued actors over one `SqlExecutor` with colliding keys each read back
// only their own rows, through the production binder and directory.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { sqlOver, createMemoryVfs, createTestRuntime } from '@kinu.run/test-utils';
import { makeSqlExec } from './helpers';
import { initWorkspaceSchema } from '../src/state/workspace-schema';
import { WorkspaceActorDirectory } from '../src/identity/workspace-actors';
import {
  createActorHost, childContextResolver, hostedChildTree, recoverActorTurns,
  type ActorHost, type BoundActor,
} from '../src/state/actor-host';
import { initEventsHubTables, EventLog } from '../src/events/hub/index';
import { initCompletedTurnTable } from '../src/evolution/session-window';
import { EvolutionEngine } from '../src/evolution/engine';
import { listRecoveryFindings } from '../src/evolution/recovery';
import { sectionArtifact, writeCandidate } from '../src/evolution/artifacts';
import { runningTrial } from '../src/evolution/trials';
import { PROMPT_SECTIONS } from '../src/prompting/section-templates';

import type { AgentOrchestratorDeps } from '../src/orchestrator/agent-orchestrator';
import type { AgentRuntime, Identity, SqlExecutor } from '../src/index';
import { actorReferenceOf, type ActorReference } from '../src/identity/actor-handle';
import type { ActorProgramIdentity, ActorTurnClaim } from '../src/orchestrator/actor-claims';
import type { ContextSelection } from '../src/session/context';
import { agentArtifactDirectory } from '../src/vfs/agent-home';
import { sha256Hex } from '../src/safety/argument-digest';
import { createRecordingLogger, setDiagnosticsSink } from '../src/obs/index';
import { WORKSPACE_ROOT } from '../src/vfs/workspace-path';
import { historyTurnPairs } from '../src/identity/conversation-store';

const BUILTIN: ActorProgramIdentity = { kind: 'builtin', version: 0, digest: null, build: 'test-build' };

interface Fixture {
  readonly db: Database;
  readonly sql: SqlExecutor;
  readonly host: ActorHost;
  readonly directory: WorkspaceActorDirectory;
  readonly main: ActorReference;
  child(name: string, creationId: string, origin: 'agent' | 'swarm'): ActorReference;
  /** A new host over the same database, as a root eviction leaves. */
  rebuild(): Fixture;
  readonly released: string[];
}

/** A real per-actor scaffold identity, since the host seeds every actor's loop pointer and bytes. */
function scaffoldIdentity(name: string, vfs: VFS, sql: SqlExecutor, actorId: string): Identity {
  const path = `agents/${name}/scaffold/agent.js`;

  return {
    id: `actor-${name}`,
    name,
    scaffold: {
      path,
      exists: () => exists(vfs, path),
      read: () => readText(vfs, path),
      write: (source: string) => writeText(vfs, path, source),
      version: async () => sql<{ version: number | null }>`
        SELECT MAX(version) AS version FROM scaffold_versions WHERE actor_id = ${actorId}`[0]?.version ?? 0,
    },
  };
}

function build(donor?: Database, unreadableActor?: string, automatic = false, installedBuild: string | null = 'test-build'): Fixture {
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
  const released: string[] = [];

  const orchestrationFor = (bound: BoundActor & { runtime: AgentRuntime }): AgentOrchestratorDeps => {
    if (bound.record.name === 'unorchestrated') throw new Error('orchestration failed');

    return orchestrationFor0(bound);
  };

  const orchestrationFor0 = (bound: BoundActor & { runtime: AgentRuntime }): AgentOrchestratorDeps => ({
    // Its own broadcast, event log and session window.
    host: {
      broadcast: () => { throw new Error(`${bound.record.name} broadcast outside a turn`); },
      enqueueTurn: async () => ({ status: 'queued' }),
      turnInFlight: () => false,
      // Nothing here arms a drain, so an armed timer is a fault to surface.
      setTimer: () => { throw new Error(`${bound.record.name} armed a drain timer outside a turn`); },
    },
    engine: new EvolutionEngine(bound.runtime, historyTurnPairs(bound.stores.history), { enabled: automatic }),
    eventLog: new EventLog(exec, bound.handle),
  });

  // Memoized per actor so the session store and runtime address the same bytes.
  const planeFor = (actorId: string): VFS => {
    const plane = planes.get(actorId) ?? createMemoryVfs().vfs;
    planes.set(actorId, plane);

    return plane;
  };

  const host = createActorHost({
    tracing: undefined,
    storage: {
      sql,
      transactionSync: (write) => db.transaction(write)(),
      exec: (query, ...bindings) => exec.exec(query, ...bindings),
    },
    directory,
    installedBuild,
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
        storage: { vfs: plane, home: WORKSPACE_ROOT, sql, execRaw, transactionSync: (write) => db.transaction(write)() },
        agentStateVfs: plane,
        identity: scaffoldIdentity(bound.record.name, plane, sql, bound.record.actorId),
        release: () => { released.push(bound.record.name); },
      };
    },
    loopFor: () => ({ origin: { kind: 'builtin' }, parent: null }),
    orchestrationFor,
    // Null: this fixture asserts hosting, not context auditing.
    contextEvents: () => null,
  });

  return {
    db, sql, host, directory, released,
    main: { actorId: mainHandle.actorId, workspaceId: mainHandle.workspaceId, parentActorId: null },
    child: (name, creationId, origin) => {
      const handle = directory.create({
        parent: mainHandle, name, creationId, origin,
        lifetime: origin === 'agent' ? 'durable' : 'task',
      });

      return { actorId: handle.actorId, workspaceId: handle.workspaceId, parentActorId: handle.parentActorId };
    },
    rebuild: () => build(db, unreadableActor, automatic, installedBuild),
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
  test('learning switched off between turns stops the independent background pass', async () => {
    const fx = build(undefined, undefined, true);
    const actor = await fx.host.acquire(fx.main, { kind: 'actor' });

    try {
      const lease = actor.session.beginTurn({ runId: 'run', turnId: 'turn' }, 'build', 0);
      actor.session.finishTurn(lease);
      actor.handle.config.setLiveTrials(true);
      const section = PROMPT_SECTIONS[0];

      if (section === undefined) throw new Error('the prompt-section registry is empty');
      writeCandidate(fx.sql, actor.handle, {
        artifactId: sectionArtifact(section.id), body: `${section.source.trimEnd()} Keep it short.`,
        rationale: 'test candidate', evidence: { turns: ['turn'], reason: 'incorrect' },
      });
      actor.handle.config.setLearning(false);
      await actor.session.orchestrator.runDueSessionEvolution();
      expect(runningTrial(fx.sql, actor.handle)).toBeNull();
      actor.handle.config.setLearning(true);
      await actor.session.orchestrator.runDueSessionEvolution();
      expect(runningTrial(fx.sql, actor.handle)).not.toBeNull();
    } finally {
      fx.host.releaseAll();
      fx.db.close();
    }
  });

  test('a learning change applies to the next turn, not the turn already opened', async () => {
    const fx = build(undefined, undefined, true);
    const actor = await fx.host.acquire(fx.main, { kind: 'actor' });

    const policies = [
      { before: true, after: false, recorded: 1 },
      { before: false, after: true, recorded: 1 },
      { before: true, after: true, recorded: 2 },
    ];

    try {
      for (const [index, policy] of policies.entries()) {
        actor.handle.config.setLearning(policy.before);
        const turnId = `learning-${index}`;
        actor.session.orchestrator.withTurnLearning(() => {
          const lease = actor.session.beginTurn({ runId: `run-${index}`, turnId }, 'build', index);
          actor.handle.config.setLearning(policy.after);
          actor.session.orchestrator.recordTurn({
            userMessage: `assignment ${index}`, assistantResponse: 'done', toolCalls: [],
            steps: 1, durationMs: 1, feedback: null, hadError: false, turnId,
          }, 'conversation');
          actor.session.finishTurn(lease);
        });
        await actor.session.orchestrator.runDueSessionEvolution();
        expect(actor.session.orchestrator.sessionTurnIndex).toBe(policy.recorded);
      }
    } finally {
      fx.host.releaseAll();
      fx.db.close();
    }
  });

  for (const policy of [
    { automatic: true, mode: 'build', findings: 1, rootTurns: 2 },
    { automatic: true, mode: 'plan', findings: 0, rootTurns: 0 },
    { automatic: false, mode: 'build', findings: 0, rootTurns: 0 },
    { automatic: false, mode: 'plan', findings: 0, rootTurns: 0 },
  ] as const) {
    test(`acquired actors keep step and turn learning separate: auto=${policy.automatic}, mode=${policy.mode}`, async () => {
      const fx = build(undefined, undefined, policy.automatic);
      const main = await fx.host.acquire(fx.main, { kind: 'actor' });

      const temporary = fx.directory.create({
        parent: main.handle, name: 'temporary', origin: 'agent', lifetime: 'task', creationId: 'temporary',
      });

      const actors = [
        { reference: fx.main, turns: policy.rootTurns },
        { reference: fx.child('hire', 'hire', 'agent'), turns: 0 },
        { reference: actorReferenceOf(temporary), turns: 0 },
      ];

      try {
        for (const expected of actors) {
          const actor = await fx.host.acquire(expected.reference, { kind: 'actor' });

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
          expect((await reopened.host.acquire(expected.reference, { kind: 'actor' })).session.orchestrator.sessionTurnIndex).toBe(expected.turns);
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
    const alpha = await fx.host.acquire(fx.child('alpha', 'c-alpha', 'agent'), { kind: 'actor' });
    const beta = await fx.host.acquire(fx.child('beta', 'c-beta', 'agent'), { kind: 'actor' });
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
    const ref = fx.child('alpha', 'c-alpha', 'agent');
    const alpha = await fx.host.acquire(ref, { kind: 'actor' });
    const claims = alpha.stores.claims;
    await claims.admit({ runId: 'r', turnId: 't', workMode: 'build', program: BUILTIN, context: contextOf(alpha) });
    expect(claims.read('t')?.runId).toBe('r');

    fx.host.release(ref);
    expect(fx.host.hosted(ref)).toBeNull();
    expect(() => claims.read('t')).toThrow(/released by its root/);
    // The rows survive releasing the runtime objects.
    expect(fx.sql<{ n: number }>`SELECT COUNT(*) AS n FROM actor_turn_claims WHERE actor_id = ${ref.actorId}`[0]?.n).toBe(1);
  });

  test('every way out of the host lets the actor go exactly once', async () => {
    const fx = build();
    const [a, b, c] = [fx.child('alpha', 'c-alpha', 'agent'), fx.child('beta', 'c-beta', 'agent'), fx.child('gamma', 'c-gamma', 'agent')];

    for (const ref of [a, b, c]) await fx.host.acquire(ref, { kind: 'actor' });
    fx.host.release(a);
    fx.host.release(a);
    await fx.host.retire(fx.main, { reference: b, name: 'beta', destroy: false, interrupt: false });
    fx.host.releaseAll();
    fx.host.releaseAll();

    expect(fx.released).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('an actor whose build fails after its runtime exists lets that runtime go', async () => {
    const fx = build();

    await expect(fx.host.acquire(fx.child('unorchestrated', 'c-un', 'agent'), { kind: 'actor' })).rejects.toThrow('orchestration failed');
    expect(fx.released).toEqual(['unorchestrated']);
  });

  test('re-acquiring an actor does not revive the binding that was released', async () => {
    const fx = build();
    const ref = fx.child('alpha', 'c-alpha', 'agent');
    const first = await fx.host.acquire(ref, { kind: 'actor' });
    const staleClaims = first.stores.claims;
    fx.host.release(ref);

    const second = await fx.host.acquire(ref, { kind: 'actor' });
    expect(second.handle).not.toBe(first.handle);
    // The new binding works…
    await second.stores.claims.admit({ runId: 'r2', turnId: 't2', workMode: 'build', program: BUILTIN, context: contextOf(second) });
    expect(second.stores.claims.read('t2')?.runId).toBe('r2');
    // …and the old one stays dead: the fence is keyed on the binding, not the actor id.
    expect(() => staleClaims.read('t2')).toThrow(/released by its root/);
  });

  test('reading a retained actor starts nothing', async () => {
    const fx = build();
    const ref = fx.child('gone', 'c-gone', 'agent');
    const hosted = await fx.host.acquire(ref, { kind: 'actor' });
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
    const a = fx.child('alpha', 'c-alpha', 'agent');
    const b = fx.child('beta', 'c-beta', 'agent');
    await fx.host.acquire(a, { kind: 'actor' });
    await fx.host.acquire(b, { kind: 'actor' });
    const order: string[] = [];
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();

    const first = fx.host.run(a, { kind: 'actor' }, async () => {
      order.push('a1-start');
      started.resolve();
      await held.promise;
      order.push('a1-end');
    });

    const second = fx.host.run(a, { kind: 'actor' }, async () => { order.push('a2'); });
    await started.promise;
    // Another actor's work runs while this one is parked.
    await fx.host.run(b, { kind: 'actor' }, async () => { order.push('b1'); });
    expect(order).toEqual(['a1-start', 'b1']);
    held.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['a1-start', 'b1', 'a1-end', 'a2']);
  });

  test('an abandoned caller does not cancel hosted work', async () => {
    const fx = build();
    const ref = fx.child('alpha', 'c-alpha', 'agent');
    const hosted = await fx.host.acquire(ref, { kind: 'actor' });
    const held = Promise.withResolvers<void>();
    let finished = false;

    // The caller starts work and walks away.
    const work = fx.host.run(ref, { kind: 'actor' }, async () => {
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
    await expect(fx.host.run(ref, { kind: 'actor' }, async () => 'again')).resolves.toBe('again');
  });

  test('destructive retirement refuses a stale alias and a stale epoch, then purges only that actor', async () => {
    const fx = build();
    const a = fx.child('alpha', 'c-alpha', 'agent');
    const b = fx.child('beta', 'c-beta', 'agent');
    const alpha = await fx.host.acquire(a, { kind: 'actor' });
    const beta = await fx.host.acquire(b, { kind: 'actor' });
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
    const a = fx.child('alpha', 'c-alpha', 'agent');
    const alpha = await fx.host.acquire(a, { kind: 'actor' });
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
    const a = fx.child('alpha', 'c-alpha', 'agent');
    const b = fx.child('beta', 'c-beta', 'agent');
    const alpha = await fx.host.acquire(a, { kind: 'actor' });
    const beta = await fx.host.acquire(b, { kind: 'actor' });
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
    const actor = await fx.host.acquire(fx.child('alpha', 'c-alpha', 'agent'), { kind: 'actor' });
    const source = 'export default async function main() { return "retained"; }';
    await writeText(actor.runtime.storage.vfs, `${actor.runtime.identity.scaffold.path}.v1`, source);

    const admitted = await actor.stores.claims.admit({
      runId: 'run-a', turnId: 'turn-a', workMode: 'build', context: contextOf(actor),
      program: { kind: 'scaffold', version: 1, digest: sha256Hex(source), build: null },
    });

    const recovered = await recoverActorTurns(fx.host);
    expect(recovered).toEqual({ verified: ['turn-a'], refused: [], failed: [], unreadable: [], active: [], stalled: [] });
    expect(actor.stores.claims.read('turn-a')).toMatchObject({ status: 'admitted', outcome: null, epoch: admitted.epoch });
    expect(await recoverActorTurns(fx.host)).toEqual(recovered);
    fx.host.releaseAll();
    fx.db.close();
  });

  test('a claim whose request record is missing is settled once, not owed on every later wake', async () => {
    const fx = build();
    const actor = await fx.host.acquire(fx.child('alpha', 'c-alpha', 'agent'), { kind: 'actor' });
    const source = 'export default async function main() { return "retained"; }';
    await writeText(actor.runtime.storage.vfs, `${actor.runtime.identity.scaffold.path}.v1`, source);

    await actor.stores.claims.admit({
      runId: 'run-a', turnId: 'turn-a', workMode: 'build', context: contextOf(actor),
      program: { kind: 'scaffold', version: 1, digest: sha256Hex(source), build: null },
    });
    // The claim stands; the request it names is gone.
    fx.db.exec("DELETE FROM actor_requests WHERE turn_id = 'turn-a'");

    expect(await recoverActorTurns(fx.host)).toMatchObject({ failed: ['turn-a'], unreadable: [], verified: [] });
    expect(actor.stores.claims.read('turn-a')).toMatchObject({ status: 'settled', outcome: 'error' });
    expect(await recoverActorTurns(fx.host)).toMatchObject({ failed: [], unreadable: [], verified: [] });
    fx.host.releaseAll();
    fx.db.close();
  });

  /** A turn whose program verifies, and one run of it: admitted again on `installedBuild`, its model called at each
   *  of `steps`, and left open there, as a run a memory or wall reset of its activation ended. */
  async function interruptedRuns(hostBuild?: string | null): Promise<{ actor: BoundActor; run: (steps: readonly number[], installedBuild?: string | null, cut?: 'provider' | 'work') => Promise<void>; fx: Fixture }> {
    const fx = build(undefined, undefined, false, hostBuild);
    const actor = await fx.host.acquire(fx.child('alpha', 'c-alpha', 'agent'), { kind: 'actor' });
    const source = 'export default async function main() { return "retained"; }';
    await writeText(actor.runtime.storage.vfs, `${actor.runtime.identity.scaffold.path}.v1`, source);
    const program: ActorProgramIdentity = { kind: 'scaffold', version: 1, digest: sha256Hex(source), build: null };

    return {
      actor, fx,
      // Each run ends where `cut` says: waiting on the provider for its last step, or running that step's own work.
      run: async (steps, installedBuild = fx.host.installedBuild, cut = 'provider') => {
        const claim = await actor.stores.claims.admit({
          runId: crypto.randomUUID(), turnId: 'turn-a', workMode: 'build', context: contextOf(actor), program, installedBuild,
        });

        for (const index of steps) await actor.stores.claims.consume(claim, { index, messages: [{ role: 'user', content: 'the brief' }] });

        if (cut === 'work') actor.stores.claims.working(claim);
      },
    };
  }

  /** Cuts in a provider wait, and in a step's own work, on one build with no step finishing, that settle a turn (D12). */
  const STALLED_PROVIDER_CUTS = 20;

  const POISON_WORK_CUTS = 6;

  test('a run our own deploy ended is no stall: only cuts on this host\'s build count, and a provider wait counts to twenty', async () => {
    const { actor, run, fx } = await interruptedRuns();
    const owed = { verified: ['turn-a'], stalled: [] };

    await run([0, 1], 'build-before');
    expect(await recoverActorTurns(fx.host)).toMatchObject(owed);
    // A deploy ended this run: this host runs another build.
    await run([0, 1], 'build-before');
    expect(await recoverActorTurns(fx.host)).toMatchObject(owed);

    // Each cut on this host's build waits on the provider: none is the step's fault, so five outside resets and more
    // stay owed, up to the bound.
    for (let cut = 1; cut < STALLED_PROVIDER_CUTS; cut += 1) {
      await run([0, 1]);
      expect(await recoverActorTurns(fx.host)).toMatchObject(owed);
    }

    await run([0, 1]);
    const recovered = await recoverActorTurns(fx.host);
    expect(recovered.stalled.map((turn) => turn.claim.turnId)).toEqual(['turn-a']);
    expect(actor.stores.claims.read('turn-a')).toMatchObject({ status: 'settled', outcome: 'error', epoch: 2 + STALLED_PROVIDER_CUTS });
    fx.host.releaseAll();
    fx.db.close();
  });

  test('a step cut in its own work, run after run, is settled at the sixth; a finished step starts the count over', async () => {
    const { actor, run, fx } = await interruptedRuns();
    const owed = { verified: ['turn-a'], stalled: [] };

    for (let cut = 1; cut < POISON_WORK_CUTS; cut += 1) {
      await run([0], undefined, 'work');
      expect(await recoverActorTurns(fx.host)).toMatchObject(owed);
    }

    // The next run finishes its step: the cuts before it say nothing about the next one.
    const claim = await actor.stores.claims.admit({
      runId: crypto.randomUUID(), turnId: 'turn-a', workMode: 'build', context: contextOf(actor),
      program: actor.stores.claims.read('turn-a')?.program ?? { kind: 'builtin', version: 0, digest: null, build: null },
      installedBuild: fx.host.installedBuild,
    });

    await actor.stores.claims.consume(claim, { index: 0, messages: [{ role: 'user', content: 'the brief' }] });
    actor.stores.claims.progressed(claim);
    actor.stores.claims.working(claim);
    expect(await recoverActorTurns(fx.host)).toMatchObject(owed);

    for (let cut = 1; cut < POISON_WORK_CUTS - 1; cut += 1) {
      await run([1], undefined, 'work');
      expect(await recoverActorTurns(fx.host)).toMatchObject(owed);
    }

    await run([1], undefined, 'work');
    expect((await recoverActorTurns(fx.host)).stalled.map((turn) => turn.claim.turnId)).toEqual(['turn-a']);
    // The run that finished a step and was then cut in its work is the first of the six.
    expect(actor.stores.claims.read('turn-a')).toMatchObject({ status: 'settled', outcome: 'error', epoch: (POISON_WORK_CUTS - 1) + POISON_WORK_CUTS });
    fx.host.releaseAll();
    fx.db.close();
  });

  test('a host with no build of its own judges no pair: relaunches of the CLI cut in a step\'s own work are not a stall', async () => {
    const { actor, run, fx } = await interruptedRuns(null);
    const owed = { verified: ['turn-a'], stalled: [] };

    for (let cut = 0; cut < POISON_WORK_CUTS; cut += 1) {
      await run([0, 1], undefined, 'work');
      expect(await recoverActorTurns(fx.host)).toMatchObject(owed);
    }

    expect(actor.stores.claims.read('turn-a')).toMatchObject({ status: 'admitted', epoch: POISON_WORK_CUTS });
    fx.host.releaseAll();
    fx.db.close();
  });

  test('a run that got further than the run before it stays owed', async () => {
    const { actor, run, fx } = await interruptedRuns();

    await run([0]);
    await recoverActorTurns(fx.host);
    await run([0, 1]);
    expect(await recoverActorTurns(fx.host)).toMatchObject({ verified: ['turn-a'], stalled: [] });
    expect(actor.stores.claims.read('turn-a')).toMatchObject({ status: 'admitted', epoch: 2 });
    fx.host.releaseAll();
    fx.db.close();
  });

  test('recovery leaves an unreadable actor claim owed across repeated opens', async () => {
    const fx = build();
    const actor = await fx.host.acquire(fx.child('alpha', 'c-alpha', 'agent'), { kind: 'actor' });
    await actor.stores.claims.admit({ runId: 'run-a', turnId: 'turn-a', workMode: 'build', context: contextOf(actor), program: BUILTIN });
    const cold = build(fx.db, 'alpha');

    const first = await recoverActorTurns(cold.host);
    expect(first).toEqual({ verified: [], refused: [], failed: [], unreadable: ['turn-a'], active: [], stalled: [] });
    expect(await recoverActorTurns(cold.host)).toEqual(first);
    expect(actor.stores.claims.read('turn-a')).toMatchObject({ status: 'admitted', outcome: null, epoch: 1 });
    cold.host.releaseAll();
    fx.host.releaseAll();
    fx.db.close();
  });

  test('recovery refuses changed program bytes once but does not settle a live actor', async () => {
    const fx = build();
    const actor = await fx.host.acquire(fx.child('alpha', 'c-alpha', 'agent'), { kind: 'actor' });
    await actor.stores.claims.admit({
      runId: 'run-a', turnId: 'turn-a', workMode: 'build', context: contextOf(actor),
      program: { kind: 'scaffold', version: 1, digest: sha256Hex('missing'), build: null },
    });
    const lease = actor.session.beginTurn({ runId: 'run-a', turnId: 'turn-a' }, 'build', 0);
    expect(await recoverActorTurns(fx.host)).toEqual({ verified: [], refused: [], failed: [], unreadable: [], active: ['turn-a'], stalled: [] });
    expect(actor.stores.claims.read('turn-a')?.status).toBe('admitted');
    actor.session.finishTurn(lease);

    expect(await recoverActorTurns(fx.host)).toEqual({ verified: [], refused: ['turn-a'], failed: [], unreadable: [], active: [], stalled: [] });
    expect(actor.stores.claims.read('turn-a')).toMatchObject({ status: 'settled', outcome: 'indeterminate', epoch: 1 });
    expect(await recoverActorTurns(fx.host)).toEqual({ verified: [], refused: [], failed: [], unreadable: [], active: [], stalled: [] });
    fx.host.releaseAll();
    fx.db.close();
  });

  test('recovery rechecks live ownership after awaited program verification', async () => {
    const fx = build();
    const actor = await fx.host.acquire(fx.child('alpha', 'c-alpha', 'agent'), { kind: 'actor' });
    const path = `${actor.runtime.identity.scaffold.path}.v1`;
    await writeText(actor.runtime.storage.vfs, path, 'changed source');
    await actor.stores.claims.admit({
      runId: 'run-a', turnId: 'turn-a', workMode: 'build', context: contextOf(actor),
      program: { kind: 'scaffold', version: 1, digest: sha256Hex('expected source'), build: null },
    });
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = actor.runtime.storage.vfs.readFile.bind(actor.runtime.storage.vfs);

    actor.runtime.storage.vfs.readFile = async (file) => {
      if (file === path) {
        reading.resolve();
        await release.promise;
      }

      return read(file);
    };

    const recovering = recoverActorTurns(fx.host);
    await reading.promise;
    const lease = actor.session.beginTurn({ runId: 'run-a', turnId: 'turn-a' }, 'build', 0);
    release.resolve();
    expect(await recovering).toEqual({ verified: [], refused: [], failed: [], unreadable: [], active: ['turn-a'], stalled: [] });
    expect(actor.stores.claims.read('turn-a')?.status).toBe('admitted');
    actor.session.finishTurn(lease);

    expect(await recoverActorTurns(fx.host)).toEqual({ verified: [], refused: ['turn-a'], failed: [], unreadable: [], active: [], stalled: [] });
    expect(actor.stores.claims.read('turn-a')?.outcome).toBe('indeterminate');
    fx.host.releaseAll();
    fx.db.close();
  });

  test('a claim whose consumed step has lost its list settles error once, and the failure names the request', async () => {
    const fx = build();
    const actor = await fx.host.acquire(fx.child('alpha', 'c-alpha', 'agent'), { kind: 'actor' });
    const claim = await actor.stores.claims.admit({ runId: 'run-a', turnId: 'turn-a', workMode: 'build', context: contextOf(actor), program: BUILTIN });
    const step = await actor.stores.claims.consume(claim, { index: 0, messages: [{ role: 'user', content: 'go' }] });
    // The row naming the step's list, which no request written before the requests lineage has.
    void fx.sql`DELETE FROM request_renders WHERE actor_id=${claim.actorId} AND request_id=${step.requestId}`;
    const log = createRecordingLogger();
    const restore = setDiagnosticsSink(log);

    try {
      expect(await recoverActorTurns(fx.host)).toEqual({ verified: [], refused: [], failed: ['turn-a'], unreadable: [], active: [], stalled: [] });
      expect(actor.stores.claims.read('turn-a')).toMatchObject({ status: 'settled', outcome: 'error', epoch: claim.epoch });
      // Settled, so the next wake's sweep neither retries it nor logs it again.
      expect(await recoverActorTurns(fx.host)).toEqual({ verified: [], refused: [], failed: [], unreadable: [], active: [], stalled: [] });
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
    const a = fx.child('alpha', 'c-alpha', 'agent');
    const b = fx.child('beta', 'c-beta', 'agent');
    const alpha = await fx.host.acquire(a, { kind: 'actor' });
    const beta = await fx.host.acquire(b, { kind: 'actor' });
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
    const a = fx.child('alpha', 'c-alpha', 'agent');
    await fx.host.acquire(a, { kind: 'actor' });

    const resolver = childContextResolver({
      directory: fx.directory, parent: fx.directory.open(fx.main.actorId),
      // The child's own recorder: an edit to a child's context is recorded against the child.
      tree: hostedChildTree(fx.host, () => null),
    });

    const storageKey = fx.host.describe(a.actorId)?.storageKey ?? '';
    expect(resolver.list()).toContain(storageKey);
    const tree = resolver.tree(storageKey, fx.main.actorId);

    if (tree === null) throw new Error('the issued child has no context tree');
    expect(await readText(tree, '/working.jsonl')).toContain(a.actorId);
    expect(resolver.tree('not-a-child', fx.main.actorId)).toBeNull();
  });
});
