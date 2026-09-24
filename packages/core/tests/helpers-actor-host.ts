/** A real hosted actor per head and node over the caller's one workspace database, via the production
 *  directory, `createActorHost` and `seedActorLoop`; a mocked session would pass while writing no claim. */
import type { Database } from 'bun:sqlite';
import { makeSqlExec } from './helpers';
import { KinuError } from '../src/obs/error';
import { initWorkspaceSchema } from '../src/state/workspace-schema';
import { WorkspaceActorDirectory, type WorkspaceActor } from '../src/identity/workspace-actors';
import { explorationActorKey } from '../src/identity/actor-key';
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
import { unobservedSpend } from '@kinu.run/test-utils';

/** The one role a fixture actor resolves under; no `allowedTools`, so it never narrows a suite's surface. */
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

export interface HostedSeats {
  readonly host: ActorHost;
  readonly directory: WorkspaceActorDirectory;
  /** Every event a hosted actor's turn published. */
  readonly broadcasts: readonly BroadcastEvent[];
  readonly enqueued: readonly ProgrammaticTurn[];
  /** The seat one logical actor's turn runs on; idempotent per name, so a re-hosted node keeps its actor. */
  seat(name: string, kind: Exclude<WorkspaceActor['kind'], 'main' | 'branch'>): Promise<HostedNodeSeat>;
  /** `hostNode` over these seats: one actor per node id, all over the one database. */
  readonly hostNode: (node: NodeIdentity) => Promise<HostedNodeSeat>;
}

/** Host logical actors as children of the caller's runtime. `db` is needed because the retirement
 *  purge reads the live schema through the positional SQL port, which `AgentRuntime.storage` lacks. */
export function hostedSeatsOver(input: {
  readonly rt: AgentRuntime;
  readonly db: Database;
  /** The activation every seat's claims are attributed to. */
  readonly runId?: string;
  /** Build every seat's engine with auto-evolution on, as both backends host an actor. Off by default:
   *  most suites want the ledgers without an enabled engine's writes. */
  readonly autoEvolve?: boolean;
}): HostedSeats {
  const { rt, db } = input;
  const runId = input.runId ?? 'run-hosted-fixture';
  const { sql, execRaw } = rt.storage;
  const exec = makeSqlExec(db);
  // `createTestRuntime` seeds the actor directory but not the claim ledger.
  initWorkspaceSchema({ execRaw, sql, exec });
  initEventsHubTables(exec);

  const directory = new WorkspaceActorDirectory(sql, { workspaceId: rt.actor.workspaceId, ownerUserId: '' });
  // Re-issued by this directory: a directory refuses handles minted by another.
  const parent = directory.main();
  const broadcasts: BroadcastEvent[] = [];
  const enqueued: ProgrammaticTurn[] = [];
  /** Timers the orchestration scheduled, held rather than fired. */
  const timers: Array<{ readonly fn: () => Promise<void>; readonly ms: number }> = [];
  const seats = new Map<string, HostedNodeSeat>();

  /** The caller's runtime, re-addressed: same database and executor, but its own handle and SCAFFOLD path,
   *  since `seedActorLoop` writes a per-actor version file. */
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
    host: {
      broadcast: (event) => { broadcasts.push(event); },
      enqueueTurn: async (turn) => {
        enqueued.push(turn);

        return { status: 'queued' };
      },
      turnInFlight: () => host.hosted(bound.reference)?.session.inFlight ?? false,
      setTimer: (fn, ms) => { timers.push({ fn, ms }); },
    },
    // The real engine; auto-evolution off unless the suite opted in.
    engine: new EvolutionEngine(bound.runtime, bound.stores.history, { reportModelCall: unobservedSpend, enabled: input.autoEvolve === true }),
    // This actor's own log: publishing into the root's rows would move another actor's turn.
    eventLog: new EventLog(exec, bound.handle),
  });

  const host = createActorHost({
    filesFor: async (bound) => {
      bound.handle.assertCurrent();

      return { vfs: rt.storage.vfs, artifactDirectory: `/actors/${bound.handle.actorId}/.kinu/context` };
    },
    storage: {
      sql,
      transactionSync: (write) => rt.storage.transactionSync(write),
      exec: (query, ...bindings) => exec.exec(query, ...bindings),
    },
    directory,
    installedBuild: 'test-build',
    runtimeFor,
    // BUILTIN: `inherit` would copy the parent's source in as v1 and select the SCAFFOLD arm.
    loopFor: () => ({ origin: { kind: 'builtin' }, parent: null }),
    orchestrationFor,
    // No run events published; a suite asserting context-edit audit rows binds its own.
    contextEvents: () => null,
  });

  const seat = async (
    name: string,
    kind: Exclude<WorkspaceActor['kind'], 'main' | 'branch'>,
  ): Promise<HostedNodeSeat> => {
    const known = seats.get(name);

    if (known) return known;

    // A head lives in the exploration address space, so a raw node id is refused; the creation id is
    // the caller's name, so re-seating a node is the same admitted creation.
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
      // The real resolver over a real catalog envelope, so role narrowing is applied, not assumed.
      profile: async ({ availableTools, workMode }) => ({
        profile: resolveTurnProfile({
          envelope: ENVELOPE, provider: PROVIDER, roleId: 'tester',
          workMode, availableTools, activeSkills: [],
        }),
        inputs: { envelope: ENVELOPE, provider: PROVIDER },
      }),
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

/** A `hostNode` for a fixture that runs no node: refuses, naming the fixture, rather than seating a fabricated actor. */
export function refuseHostNode(reason: string): (node: NodeIdentity) => Promise<HostedNodeSeat> {
  return (node) => {
    throw new KinuError('unavailable', `${reason} (asked for node ${node.nodeId})`);
  };
}
