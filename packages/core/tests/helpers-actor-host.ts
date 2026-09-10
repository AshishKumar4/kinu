/**
 * A REAL hosted actor per head and per node, over the caller's ONE workspace
 * database.
 *
 * A head's and a node's turn is a CLAIMED actor turn on the common
 * `ActorSession` (open-41): the session pins the program, admits the durable
 * claim naming that program's version and source digest, records the exact
 * array each step consumed, and owns the abort. So a fixture cannot hand a bare
 * `AgentRuntime` to `runHeadInference` or to a node's own run — it has to
 * supply the actor those turns belong to.
 *
 * This is that fixture, and it is deliberately the PRODUCTION path: the
 * production directory issues the actor, the production `createActorHost` binds
 * its handle, stores, runtime and session, the production `seedActorLoop` seeds
 * its loop pointer, and every one of them lands in the SAME database the
 * caller's runtime already holds. Nothing here is mocked, because a mocked
 * session would let a head's turn pass every assertion while writing no claim.
 *
 * ONE helper rather than a copy per suite: fifteen suites need a hosted actor,
 * they all need the same one, and fifteen copies of an orchestration seam is
 * fifteen places for the shape to drift from the host's.
 */
import type { Database } from 'bun:sqlite';
import { makeSqlExec } from './helpers';
import { KinuError } from '../src/obs/error';
import { initWorkspaceSchema } from '../src/identity/workspace-schema';
import { WorkspaceActorDirectory, type WorkspaceActor } from '../src/state/workspace-actors';
import { explorationActorKey } from '../src/state/actor-key';
import { createActorHost, type ActorHost, type BoundActor } from '../src/state/actor-host';
import { initEventsHubTables, EventLog } from '../src/events/hub/index';
import { EvolutionEngine } from '../src/evolution/engine';
import { createScaffoldSurface } from '../src/scaffold/surface';
import { resolveTurnProfile, type ProviderCatalogSnapshot } from '../src/profiles/resolve';
import {
  profileCatalogDigest,
  type ProfileCatalogEnvelope, type RoleDefinition, type TierAssignments,
} from '../src/profiles/catalog';
import type { HostedNodeSeat } from '../src/strategy/node-agent';
import type { NodeIdentity } from '../src/strategy/node-workspace';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { AgentOrchestratorDeps } from '../src/orchestrator/agent-orchestrator';
import type { BroadcastEvent, ProgrammaticTurn } from '../src/types/backend-host';
import type { Identity } from '../src/types/primitives';

/** The one role a hosted fixture actor resolves under. No `allowedTools`, so
 *  the role never narrows the surface a suite assembled — a suite testing the
 *  narrowing declares its own catalog. */
const TESTER: RoleDefinition = {
  description: 'Runs one hosted turn under test.',
  instructions: 'Answer the task.',
  tier: 'default',
  preset: 'ideate',
  spawns: '*',
};
const TIERS: TierAssignments = { default: { model: 'test-model' } };
const PROVIDER: ProviderCatalogSnapshot = { revision: 'rev-hosted-fixture', availableModels: ['test-model'] };

function envelope(): ProfileCatalogEnvelope {
  const catalog = { roles: { tester: TESTER }, tiers: TIERS };
  return { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog };
}
const ENVELOPE = envelope();

/** Every hosted actor of one workspace, and the seats their turns run on. */
export interface HostedSeats {
  readonly host: ActorHost;
  readonly directory: WorkspaceActorDirectory;
  /** Every event a hosted actor's turn published — the fixture's client. */
  readonly broadcasts: readonly BroadcastEvent[];
  /** Every turn a hosted actor's orchestration asked the host to inject. */
  readonly enqueued: readonly ProgrammaticTurn[];
  /**
   * The seat ONE logical actor's turn runs on, by name. Idempotent per name, so
   * a node re-hosted mid-run gets the actor it already had rather than a second
   * one wearing its id.
   */
  seat(name: string, kind: Exclude<WorkspaceActor['kind'], 'main' | 'branch'>): Promise<HostedNodeSeat>;
  /** `NodeAgentDeps.hostNode` / `SwarmRunDeps.hostNode` over these seats: one
   *  actor per node id, all of them over the one database. */
  readonly hostNode: (node: NodeIdentity) => Promise<HostedNodeSeat>;
}

/**
 * Host logical actors as CHILDREN of the caller's own runtime, over the caller's
 * own database.
 *
 * `db` as well as `rt` because the retirement purge reads its table list off
 * the live schema and therefore needs the positional SQL port, which
 * `AgentRuntime.storage` does not carry.
 */
export function hostedSeatsOver(input: {
  readonly rt: AgentRuntime;
  readonly db: Database;
  /** The activation every seat's claims are attributed to. */
  readonly runId?: string;
}): HostedSeats {
  const { rt, db } = input;
  const runId = input.runId ?? 'run-hosted-fixture';
  const { sql, execRaw } = rt.storage;
  const exec = makeSqlExec(db);
  // Idempotent, and needed either way: `createTestRuntime` seeds the actor
  // directory but not the claim ledger a hosted turn writes into.
  initWorkspaceSchema({ execRaw, sql, exec });
  initEventsHubTables(exec);

  const directory = new WorkspaceActorDirectory(sql, { workspaceId: rt.actor.workspaceId, ownerUserId: '' });
  // The caller's main actor, re-issued by THIS directory. A directory only
  // accepts handles it minted itself, so passing `rt.actor` — bound by whatever
  // directory `createTestRuntime` built — is refused as belonging to another
  // directory. Same row, same workspace, this instance's binding.
  const parent = directory.main();
  const broadcasts: BroadcastEvent[] = [];
  const enqueued: ProgrammaticTurn[] = [];
  /** Drain timers the orchestration scheduled. Held rather than fired: a
   *  fixture that ran them would start work no assertion here asked for. */
  const timers: Array<{ readonly fn: () => Promise<void>; readonly ms: number }> = [];
  const seats = new Map<string, HostedNodeSeat>();

  /**
   * The hosted actor's runtime: the caller's, re-addressed.
   *
   * The same database, the same file plane, the same executor and model — one
   * physical workspace is the whole claim. What changes is the handle every
   * store re-validates and the SCAFFOLD path, which is per actor because
   * `seedActorLoop` writes this actor's own version file and two actors sharing
   * one path would each read the other's program.
   */
  const runtimeFor = (bound: BoundActor): AgentRuntime => {
    const identity: Identity = {
      id: bound.record.actorId,
      name: bound.record.name,
      scaffold: createScaffoldSurface({
        vfs: rt.storage.vfs, sql, actor: bound.handle,
        path: `actors/${bound.record.storageKey}/scaffold/agent.js`,
      }),
    };
    return { ...rt, actor: bound.handle, identity };
  };

  const orchestrationFor = (bound: BoundActor & { readonly runtime: AgentRuntime }): AgentOrchestratorDeps => ({
    // This actor's OWN client, queue and timers — never the caller's.
    host: {
      broadcast: (event) => { broadcasts.push(event); },
      enqueueTurn: async (turn) => { enqueued.push(turn); return { status: 'queued' }; },
      turnInFlight: () => host.hosted(bound.reference)?.session.inFlight ?? false,
      setTimer: (fn, ms) => { timers.push({ fn, ms }); },
    },
    // The REAL engine over this actor's runtime, with auto-evolution off: a
    // hosted head or node under test records no evolution state, and every
    // ledger the orchestrator reads is the one the engine owns.
    engine: new EvolutionEngine(bound.runtime, { enabled: false }),
    // This actor's OWN log, bound to the handle the host bound: a child that
    // published into the root's rows would be one actor's turn moving another's.
    eventLog: new EventLog(exec, bound.handle),
  });

  const host = createActorHost({
    storage: { sql, transactionSync: rt.storage.transactionSync, exec: exec.exec },
    directory,
    installedBuild: 'test-build',
    runtimeFor,
    // BUILTIN, so a hosted head or node runs the shared chat loop its suite
    // scripts a model for. `inherit` would copy the parent's source in as this
    // actor's v1 and select the SCAFFOLD arm, which is a different program and
    // a different suite's subject.
    loopFor: () => ({ origin: { kind: 'builtin' }, parent: null }),
    orchestrationFor,
    // This fixture publishes no run events, which is the honest answer rather
    // than a default: a suite asserting context-edit audit rows binds its own.
    contextEvents: () => null,
  });

  const seat = async (
    name: string,
    kind: Exclude<WorkspaceActor['kind'], 'main' | 'branch'>,
  ): Promise<HostedNodeSeat> => {
    const known = seats.get(name);
    if (known) return known;
    // A head lives in the EXPLORATION address space, which the
    // directory enforces for every non-subordinate kind — a raw node id is
    // refused. The creation id is the caller's name, so re-seating one node is
    // the same admitted creation rather than a second actor.
    const handle = directory.create({
      parent,
      name: kind === 'subordinate' ? name : explorationActorKey(name),
      creationId: `creation-${name}`,
      kind,
      lifetime: kind === 'subordinate' ? 'durable' : 'task',
    });
    const actor = await host.acquire({
      actorId: handle.actorId, workspaceId: handle.workspaceId, parentActorId: handle.parentActorId,
    });
    const seated: HostedNodeSeat = {
      actor,
      runId,
      // The REAL resolver over a real catalog envelope, so the role narrowing
      // every full kind now runs under is actually applied rather than assumed.
      profile: async ({ availableTools, workMode }) => ({
        profile: resolveTurnProfile({
          envelope: ENVELOPE, provider: PROVIDER, roleId: 'tester',
          workMode, availableTools, activeSkills: [],
        }),
        inputs: { envelope: ENVELOPE, provider: PROVIDER },
      }),
      // No live block: this actor holds no background job, task or approval, so
      // there is nothing for a step to render. Stated, not defaulted.
      dynamic: () => ({}),
    };
    seats.set(name, seated);
    return seated;
  };

  return {
    host,
    directory,
    broadcasts,
    enqueued,
    seat,
    hostNode: (node) => seat(node.nodeId, 'head'),
  };
}

/**
 * A `hostNode` for a fixture that genuinely runs NO node.
 *
 * REFUSES rather than answers, and that is the point: a stub seat would let a
 * suite that quietly grew a node run one under a fabricated actor, and the
 * refusal names which fixture was asked instead.
 */
export function refuseHostNode(reason: string): (node: NodeIdentity) => Promise<HostedNodeSeat> {
  return (node) => {
    throw new KinuError('unavailable', `${reason} (asked for node ${node.nodeId})`);
  };
}
