/** A real hosted actor per head and node over the caller's one workspace database, via the production
 *  directory, `createActorHost` and `seedActorLoop`; a mocked session would pass while writing no claim. */
import type { Database } from 'bun:sqlite';
import { makeSqlExec, storesFor } from './helpers';
import { WorkspaceJobAuthorities } from '../src/jobs/authorities';
import { BackgroundJobRunner } from '../src/jobs/runner';
import { initBackgroundJobsTable } from '../src/jobs/store';
import { KinuError } from '../src/obs/error';
import { initWorkspaceSchema } from '../src/state/workspace-schema';
import { WorkspaceActorDirectory } from '../src/identity/workspace-actors';
import { explorationActorKey } from '../src/identity/actor-key';
import { createActorHost, type ActorHost, type BoundActor } from '../src/state/actor-host';
import type { AgentTracing } from '../src/obs/agent-tracing';
import { initEventsHubTables, EventLog } from '../src/events/hub/index';
import { EvolutionEngine } from '../src/evolution/engine';
import { createScaffoldSurface } from '../src/scaffold/surface';
import type { ProviderCatalogSnapshot } from '../src/profiles/resolve';
import { ConversationSearchStore } from '../src/memory/conversation-search';
import {
  profileCatalogDigest,
  type ProfileCatalogEnvelope, type RoleDefinition, type TierAssignments,
} from '../src/profiles/catalog';
import type { HostedNodeSeat } from '../src/strategy/node-agent';
import { runHeadInference, type HeadInferenceDeps } from '../src/heads/head-inference';
import { modelWindow } from '../src/context-window';
import { conversationKey, vfsTurnSkills, type RunTurnSources } from '../src/orchestrator/turn-assembly';
import { captureOperationProfile } from '../src/profiles/operation';
import type { HostedActor } from '../src/state/actor-host';
import type { LanguageModel } from 'ai';
import type { NodeIdentity } from '../src/strategy/node-workspace';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { AgentOrchestratorDeps } from '../src/orchestrator/agent-orchestrator';
import type { BroadcastEvent, ProgrammaticTurn } from '../src/types/backend-host';
import type { Identity } from '../src/types/primitives';
import type { TemporaryAgentPort } from '../src/types/subordinates';
import { historyTurnPairs } from '../src/identity/conversation-store';

type FixtureSeat = HostedNodeSeat;

/** The one role a fixture actor resolves under; no `allowedTools`, so it never narrows a suite's surface. */
const TESTER: RoleDefinition = {
  description: 'Runs one hosted turn under test.',
  instructions: 'Answer the task.',
  tier: 'default',
  preset: 'ideate',
  spawns: '*',
};

const TIERS: TierAssignments = { default: { model: 'fake/test-model' } };

const PROVIDER: ProviderCatalogSnapshot = { revision: 'rev-hosted-fixture', availableModels: ['fake/test-model'] };

/** The fixture's catalog: its one role on `tiers`. */
export function fixtureCatalog(tiers: TierAssignments): ProfileCatalogEnvelope {
  const catalog = { roles: { tester: TESTER }, tiers };

  return { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog };
}

const ENVELOPE = fixtureCatalog(TIERS);

/** A run's compaction trigger, kept in memory: no fold runs here, but a run measures and arms as every turn does. */
export function fixtureCompaction(key = 'fixture-run'): HeadInferenceDeps['compaction'] {
  const tokens = new Map<string, { readonly tokens: number; readonly historyLength: number }>();
  const armed = new Set<string>();

  return {
    key,
    state: {
      loadPromptTokens: (sessionKey, historyLength) => {
        const saved = tokens.get(sessionKey);

        return saved !== undefined && saved.historyLength === historyLength ? saved.tokens : null;
      },
      takeArmedCompaction: (sessionKey) => armed.delete(sessionKey),
      savePromptTokens: (sessionKey, saved, historyLength) => { tokens.set(sessionKey, { tokens: saved, historyLength }); },
      armCompaction: (sessionKey) => { armed.add(sessionKey); },
    },
  };
}

/** A run's actor, sources and compaction over `seat`, its turns on `model`. */
export function runningOn(seat: HostedNodeSeat, model: LanguageModel): Pick<HeadInferenceDeps, 'actor' | 'runId' | 'sources' | 'compaction'> {
  return {
    actor: seat.actor, runId: seat.runId,
    sources: { ...seat.sources, models: { ...seat.sources.models, resolve: () => model } },
    compaction: fixtureCompaction(seat.actor.record.actorId),
  };
}

/** Where a fixture actor's turns are assembled from: the production assembly over its own stores, a role with no
 *  narrowing, the catalog's default window, and the model a suite hands it. */
export function fixtureRunSources(actor: HostedActor, model: (spec: string) => LanguageModel): RunTurnSources {
  actor.stores.config.setRoleSelection('tester');

  return {
    rt: actor.runtime,
    backend: 'cli-local',
    executors: () => [],
    config: actor.stores.config,
    models: {
      catalog: { window: () => modelWindow(null), windowFor: async () => modelWindow(null), warm: async () => {}, acceptedMedia: () => new Set() },
      // A suite's bare model id is addressed under the fake provider: a spec names its provider.
      normalize: (spec) => (spec.includes('/') ? spec : `fake/${spec}`),
      resolve: (spec) => model(spec.replace(/^fake\//, '')),
    },
    skills: vfsTurnSkills(actor.runtime.storage.vfs, actor.stores.config, () => 'approved'),
    profileInputs: async () => ({ envelope: ENVELOPE, provider: PROVIDER }),
    agentsActions: () => [],
    temporaryAsk: () => false,
    soul: async () => undefined,
    agentsMd: async () => ({ admitted: [], referenced: [] }),
    identity: async () => ({ agent: actor.record.name }),
    artifacts: () => ({ sections: {}, tools: { descriptions: {}, fields: {} } }),
    taskPlan: () => null,
    conversationKey: () => conversationKey('fixture', actor.record.actorId),
    scaffoldSpend: { source: 'scaffold', report: () => {} },
    attachmentBudget: actor.session.orchestrator.acc.context,
    extensions: () => [],
    dynamic: () => () => ({}),
    operation: (profile, inputs) => captureOperationProfile({ actor: actor.handle, profile, inputs, runId: 'run-hosted-fixture', turnId: null }),
  };
}

export interface HostedSeats {
  readonly host: ActorHost;
  readonly directory: WorkspaceActorDirectory;
  /** Every event a hosted actor's turn published. */
  readonly broadcasts: readonly BroadcastEvent[];
  readonly enqueued: readonly ProgrammaticTurn[];
  /** The seat one logical actor's turn runs on; idempotent per name, so a re-hosted node keeps its actor. */
  seat(name: string, origin: 'agent' | 'swarm'): Promise<FixtureSeat>;
  /** `hostNode` over these seats: one actor per node id, all over the one database. */
  readonly hostNode: (node: NodeIdentity) => Promise<HostedNodeSeat>;
  /** The workspace's job registry every seat's loop attaches to; its root is the caller's runtime's actor. */
  readonly jobs: WorkspaceJobAuthorities;
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
  /** Spans every seat's turns. */
  readonly tracing?: AgentTracing;
  /** The port every seat hires its advisor through; absent, no seat is reviewed. */
  readonly advisorPort?: TemporaryAgentPort;
  /** The model every seat's turns run on; read per turn. Absent, a seat that runs a turn refuses it. */
  readonly model?: (spec: string) => LanguageModel;
}): HostedSeats {
  const { rt, db } = input;
  const runId = input.runId ?? 'run-hosted-fixture';
  const { sql, execRaw } = rt.storage;
  const exec = makeSqlExec(db);
  // `createTestRuntime` seeds the actor directory but not the claim ledger.
  initWorkspaceSchema({ execRaw, sql, exec, transactionSync: (write) => rt.storage.transactionSync(write) });
  initEventsHubTables(exec);

  const directory = new WorkspaceActorDirectory(sql, { workspaceId: rt.actor.workspaceId, ownerUserId: '' });
  // Re-issued by this directory: a directory refuses handles minted by another.
  const parent = directory.main();
  const broadcasts: BroadcastEvent[] = [];
  const enqueued: ProgrammaticTurn[] = [];
  /** Timers the orchestration scheduled, held rather than fired. */
  const timers: Array<{ readonly fn: () => Promise<void>; readonly ms: number }> = [];
  const seats = new Map<string, FixtureSeat>();
  initBackgroundJobsTable(execRaw);
  const rootStore = storesFor(rt).jobs;

  const rootJobs = {
    kind: 'root', actorId: rt.actor.actorId, store: rootStore,
    runner: new BackgroundJobRunner({ store: rootStore, fiber: rt.schedule.fiber.bind(rt.schedule), inbox: { send: async () => 'queued' } }),
  } as const;

  const jobs = new WorkspaceJobAuthorities({ root: () => rootJobs, revive: () => null });

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
    engine: new EvolutionEngine(bound.runtime, historyTurnPairs(bound.stores.history), { enabled: input.autoEvolve === true }),
    // This actor's own log: publishing into the root's rows would move another actor's turn.
    eventLog: new EventLog(exec, bound.handle),
  });

  const tracing = input.tracing;

  const host = createActorHost({
    tracing: tracing && (() => tracing),
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
    advisorPort: () => input.advisorPort ?? null,
  });

  const seat = async (
    name: string,
    origin: 'agent' | 'swarm',
  ): Promise<FixtureSeat> => {
    const known = seats.get(name);

    if (known) return known;

    // A head lives in the exploration address space, so a raw node id is refused; the creation id is
    // the caller's name, so re-seating a node is the same admitted creation.
    const handle = directory.create({
      parent,
      name: origin === 'agent' ? name : explorationActorKey(name),
      creationId: `creation-${name}`,
      origin,
      lifetime: origin === 'agent' ? 'durable' : 'task',
    });

    const actor = await host.acquire({
      actorId: handle.actorId, workspaceId: handle.workspaceId, parentActorId: handle.parentActorId,
    }, { kind: origin === 'swarm' ? 'node' : 'actor' });

    const compaction = fixtureCompaction(actor.record.actorId);

    const seated: FixtureSeat = {
      actor,
      runId,
      // The real assembly over a real catalog envelope, so role narrowing is applied, not assumed.
      sources: fixtureRunSources(actor, input.model ?? (() => {
        throw new KinuError('unavailable', `the hosted fixture was given no model, so ${name} cannot run a turn`);
      })),
      infer: (headInput, inference) => runHeadInference(headInput, { ...inference, compaction }),
      conversations: new ConversationSearchStore(actor.runtime.storage.sql, actor.handle, (sessionId) => actor.stores.history.transcript(sessionId)),
      jobs: { ports: { jobOutput: () => {} }, attach: (authority) => jobs.attach(authority) },
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
    hostNode: (node) => seat(node.nodeId, 'swarm'),
    jobs,
  };
}

/** A swarm's node seats and its caller model, one model for both: a node resolves its model through its seat. */
export function swarmSeats(input: Omit<Parameters<typeof hostedSeatsOver>[0], 'model'>, model: () => LanguageModel) {
  let made: LanguageModel | null = null;
  const once = (): LanguageModel => (made ??= model());

  return { hostNode: hostedSeatsOver({ ...input, model: once }).hostNode, model: once };
}

/** A `hostNode` for a fixture that runs no node: refuses, naming the fixture, rather than seating a fabricated actor. */
export function refuseHostNode(reason: string): (node: NodeIdentity) => Promise<HostedNodeSeat> {
  return (node) => {
    throw new KinuError('unavailable', `${reason} (asked for node ${node.nodeId})`);
  };
}
