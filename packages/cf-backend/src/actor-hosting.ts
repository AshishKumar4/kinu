/**
 * Logical actors hosted in the root DO: the root owns all actor SQL, scoped by
 * `actor_id`; this module supplies each actor's runtime and orchestration.
 * An actor owns its rows, its state subtree and its home uid; it shares the
 * workspace file plane (tests/unit-head-fork.test.ts) and the immutable catalogs.
 * Only an explicit cancel RPC cancels hosted work; eviction must leave it resumable.
 * Not facets: `do.facet.cpu_shared` means a facet wave serialises like one isolate.
 */

import type { Agent, AgentContext } from 'agents';
import {
  childContextResolver, localContextTree, type ContextEditor, type ContextTree, createActorHost, defaultLoopOrigin, runEventSinks, EvolutionEngine, EventLog, MissionGovernor,
  facetHomeProvisioner, facetHomeReleaser, headAgentName, subordinateAgentName, parseActorKey, actorStateRoot,
  actorScaffoldPath, nimbusSessionFiles, agentArtifactDirectory, agentHome, MAIN_AGENT, type ActorHost,
  type ActorHostDeps, type ActorRetirement, type BoundActor, type ActorHandle, type ActorReference,
  type AgentOrchestratorDeps, type AgentRuntime, type BackendHost, type BroadcastEvent,
  type ContextEventRecorder, type DeferredApprovalChannel, type EnqueueTurnResult, type LoopOrigin,
  type ModelCallReport, type ModelOperationSink, type ModelPricing, type NimbusSandboxHandle,
  type NodeHomeHost, type NodeWorkspace, type ProfileAuthorityInputs, type ProgrammaticTurn,
  type ResolvedTurnProfile, type SlateCallResult, type SlateOperation, type SqlExec,
  type SqlExecutor, type SqlValue, type WorkMode, type WorkspaceActor, type WorkspaceActorDirectory,
  type WriteObserver, isSubordinateOrigin, type TierRefusals,
} from '@kinu.run/core';
import { isVfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { flight, KinuError, settle, type AgentTracing } from '@kinu.run/core/obs';
import { Cause, Effect } from 'effect';
import { createCFRuntime, type CFRuntime, type CFRuntimeHooks } from './runtime';
import type { LiveRead, TemporaryAgentPort } from '@kinu.run/core';

/** The root agents-SDK members a hosted actor's runtime borrows; projected from `Agent` so upstream drift fails to compile. */
export type HostRootAgent = Pick<Agent<Env>, 'name' | 'sql' | 'runFiber'>;

/** Everything the root lends hosted actors; anything absent here a child builds for itself. */
export interface WorkspaceHostSeams {
  readonly env: Env;
  readonly ctx: AgentContext;
  readonly agent: HostRootAgent;
  currentTurn(reference: ActorReference): string | null;
  /** The root's own runtime: inheriting children read the retained program from it. */
  rootRuntime(): AgentRuntime;
  contextTree(actorId: string, editor: ContextEditor): ContextTree;
  readonly sql: SqlExecutor;
  /** Positional executor over the same database; the event log and archive reader need it. */
  readonly exec: SqlExec;
  readonly directory: WorkspaceActorDirectory;
  /** The registered workspace name. A self-named child derives a second, empty filesystem. */
  readonly workspaceName: string;
  installedBuild(): string | null;
  ownerUserId(): string | null;
  capabilityToken(): string | null;
  workspaceBox(shellId: string): NimbusSandboxHandle;
  /** Root-owned uid-0 view, principal registry and uid table, so homes are provisioned in this isolate. */
  homeHost(): Promise<NodeHomeHost>;
  readonly homes: HostedActorHomes;
  /** The profile authority chats resolve through, so role restrictions narrow heads, nodes and subordinates identically. */
  resolveProfile(input: {
    readonly actor: ActorHandle;
    readonly availableTools: readonly string[];
    readonly workMode: WorkMode;
  }): Promise<{ readonly profile: ResolvedTurnProfile; readonly inputs: ProfileAuthorityInputs }>;
  reportModelCall(report: ModelCallReport): void;
  refusals(actor: ActorHandle): TierRefusals;
  liveReadsMoved(reads: readonly LiveRead[]): void;
  readonly modelOperations: ModelOperationSink;
  pricing(spec?: string): ModelPricing | null;
  hostedModel(actor: ActorHandle): string | undefined;
  /** Client fan-out, stamped with the actor so panes never share one stream. */
  broadcast(actorId: string, event: BroadcastEvent): void;
  turnClaimChanged(): void;
  enqueueTurn(actor: BoundActor, input: ProgrammaticTurn): Promise<EnqueueTurnResult>;
  /**
   * Is this actor mid-turn. Takes the bound actor, not an id: the host checks the
   * whole reference, and an id would make the root's own reads fail `slotFor`.
   */
  turnInFlight(actor: BoundActor): boolean;
  setTimer(fn: () => Promise<void>, ms: number): void;
  /** Re-derive the root's alarm; a hosted actor has no alarm slot of its own. */
  reconcileDurableWake(): void;
  logActivity(actorId: string, event: string, detail?: string): void;
  tracing(): AgentTracing;
  slate(actor: ActorHandle, operation: SlateOperation): Promise<SlateCallResult>;
  /** The owner's needs-you queue: one per workspace. */
  deferrals(): DeferredApprovalChannel | undefined;
  refinementLane(bound: BoundActor & { readonly runtime: AgentRuntime }): () => Promise<void>;
  /** The port a hosted actor hires its advisor through, as every hire goes; absent, none is reviewed. */
  advisorPort?(reference: ActorReference): TemporaryAgentPort;
  /** The loop origin a creation site named for this actor, or null for the kind's default. */
  chosenLoopOrigin(record: WorkspaceActor): LoopOrigin | null;
  /**
   * The write observer a run named for this actor, or null. A register filled before
   * `acquire`, like {@link chosenLoopOrigin}; never a widened core seam.
   */
  chosenWriteObserver(record: WorkspaceActor): WriteObserver | null;
}

/** Where a hosted actor lives: one reader. */
export interface HostedActorPlacement {
  /** A swarm node's home is in `head-`. */
  readonly homeName: string | null;
  /** Origin-prefixed: a head's and a subordinate's differ. */
  readonly shellId: string;
}

export function hostedActorPlacement(record: WorkspaceActor): HostedActorPlacement {
  if (record.origin === 'system') return { homeName: null, shellId: `agent:${record.name}` };
  const id = parseActorKey(record.storageKey).id;
  const subordinate = isSubordinateOrigin(record.origin);

  return {
    homeName: subordinate ? subordinateAgentName(id) : headAgentName(id),
    shellId: `${subordinate ? 'subordinate' : 'run'}:${record.storageKey}`,
  };
}

/**
 * Provision one hosted actor's home. The single implementation: the swarm's
 * `provisionNodeHome` must report the same home. Keyed on the storage key, never a raw id.
 */

export class HostedActorHomes {
  private readonly homes = flight(({ record, reference }: { readonly record: WorkspaceActor; readonly reference: ActorReference }) => Effect.flatMap(
    Effect.promise(() => this.provision(record, reference)),
    (home) => (home.isolation === 'private-home' ? Effect.succeed(home) : Effect.fail(new KinuError('denied', 'A hosted actor requires its own credential.'))),
  ), { key: ({ record }) => record.actorId, keep: 'success' });

  constructor(private readonly seams: Pick<WorkspaceHostSeams, 'homeHost' | 'directory'>) {}

  async provision(record: WorkspaceActor, reference: ActorReference): Promise<NodeWorkspace> {
    const { homeName } = hostedActorPlacement(record);

    if (homeName === null) return settle(Effect.fail(new KinuError('denied', `Actor ${record.name} has no home of its own.`)));
    const path = this.seams.directory.storagePath(reference);
    const provision = facetHomeProvisioner(this.seams.homeHost(), () => { this.seams.directory.validate(reference, path); });

    return await provision(homeName);
  }

  get(record: WorkspaceActor, reference: ActorReference): Promise<Extract<NodeWorkspace, { isolation: 'private-home' }>> | null {
    if (hostedActorPlacement(record).homeName === null) return null;

    return settle(this.homes({ record, reference }));
  }

  require(record: WorkspaceActor, reference: ActorReference): Promise<Extract<NodeWorkspace, { isolation: 'private-home' }>> {
    const home = this.get(record, reference);

    if (home !== null) return home;

    return settle(Effect.fail(new KinuError('denied', `Actor ${record.name} has no home of its own.`)));
  }

  forget(actorId: string): void {
    this.homes.forget(actorId);
  }
}

export function createWorkspaceActorHost(seams: WorkspaceHostSeams): ActorHost {
  const runtimes = new WeakMap<ActorHandle, CFRuntime>();
  let host: ActorHost | null = null;

  const deps: ActorHostDeps = {
    storage: {
      sql: seams.sql,
      transactionSync: <Result>(write: () => Result): Result => seams.ctx.storage.transactionSync(write),
      exec: (query: string, ...bindings: readonly SqlValue[]) => seams.ctx.storage.sql.exec(query, ...bindings),
    },
    directory: seams.directory,
    installedBuild: seams.installedBuild(),
    workspace: seams.workspaceName,
    tracing: () => seams.tracing(),
    filesFor: (bound) => {
      return settle(Effect.gen(function* () {
        const provisioning = seams.homes.get(bound.record, bound.reference);
        const box = seams.workspaceBox(hostedActorPlacement(bound.record).shellId);

        if (provisioning === null) {
          if (bound.record.origin !== 'system') return yield* new KinuError('denied', 'Actor has no credentialed artifact home');

          return { vfs: nimbusSessionFiles(box, { home: agentHome(MAIN_AGENT) }), artifactDirectory: agentArtifactDirectory(agentHome(MAIN_AGENT)) };
        }

        const home = yield* Effect.promise(async () => provisioning);

        return { vfs: nimbusSessionFiles(box, home), artifactDirectory: agentArtifactDirectory(home.home) };
      }));
    },

    runtimeFor: async (bound: BoundActor): Promise<AgentRuntime> => {
      const held = runtimes.get(bound.handle);

      if (held) return held;
      const home = seams.homes.get(bound.record, bound.reference);

      const hooks: CFRuntimeHooks = {
        reportModelCall: (report) => { seams.reportModelCall(report); },
        modelOperations: seams.modelOperations,
        currentTurn: (reference) => seams.currentTurn(reference),
        // Built with the runtime, which lives as long as this actor stays bound.
        refusals: seams.refusals(bound.handle),
        liveReadsMoved: (reads) => { seams.liveReadsMoved(reads); },
        slate: (operation) => seams.slate(bound.handle, operation),
        deferrals: () => seams.deferrals(),
        // The chat's authority: a self-resolved profile could differ from the turn's and make a search unreproducible.
        resolveProfile: async () => (await seams.resolveProfile({
          actor: bound.handle, availableTools: [], workMode: 'build',
        })).profile,
        contextPlane: {
          actorId: bound.handle.actorId,
          own: () => (bound.handle.parentActorId === null
            ? localContextTree(() => ({ claims: bound.stores.claims, events: contextEventsFor(bound) }), { author: bound.handle.actorId, child: false })
            : seams.contextTree(bound.handle.actorId, { author: bound.handle.actorId, child: false })),
          children: childContextResolver({
            directory: seams.directory,
            parent: bound.handle,
            tree: (child, author) => seams.contextTree(child.actorId, { author, child: true }),
          }),
        },
      };

      if (home !== null) hooks.workspaceExecution = await home;
      // Assigned, not declared above: `createCFRuntime` reads key presence to decide whether
      // to wrap the file view, and an unwatched head reports no file changes.
      const writes = seams.chosenWriteObserver(bound.record);

      if (writes !== null) hooks.workspaceObserver = writes;

      const runtime = createCFRuntime(seams.agent, {
        env: seams.env,
        ctx: seams.ctx,
        workspaceBox: (shellId) => seams.workspaceBox(shellId),
      }, {
        actor: bound.handle,
        // Not this actor's name: a self-named child derives a second, empty filesystem.
        workspaceName: seams.workspaceName,
        rootActor: bound.record.origin === 'system',
        ownerUserId: () => seams.ownerUserId(),
        shellId: hostedActorPlacement(bound.record).shellId,
        scaffoldPath: actorScaffoldPath(bound.record),
        capabilityToken: () => seams.capabilityToken(),
      }, hooks);

      runtimes.set(bound.handle, runtime);

      return runtime;
    },

    /**
     * Heads and branches inherit the parent's promoted loop; hired subordinates start builtin.
     * The root is always a readable parent (inheritance needs only durable state); a deeper
     * parent must be live, else the guard refuses rather than silently starting builtin.
     */
    loopFor: async (bound) => {
      const origin = seams.chosenLoopOrigin(bound.record) ?? defaultLoopOrigin(bound.record.origin);

      if (origin.kind !== 'inherit' || bound.record.parentActorId === null || host === null) {
        return { origin, parent: null };
      }

      const parentRecord = host.describe(bound.record.parentActorId);

      if (parentRecord === null) return { origin, parent: null };

      if (parentRecord.parentActorId === null) return { origin, parent: seams.rootRuntime() };

      const live = host.hosted({
        actorId: parentRecord.actorId,
        workspaceId: parentRecord.workspaceId,
        parentActorId: parentRecord.parentActorId,
      });

      return { origin, parent: live === null ? null : live.runtime };
    },

    /** Per actor: context-edit evidence belongs to the actor whose context moved. */
    contextEvents: (bound) => contextEventsFor(bound),

    /** The actor's own event log, engine, governor and broadcast, never the root's objects. */
    orchestrationFor: (bound): AgentOrchestratorDeps => {
      const { runtime, stores, handle } = bound;
      stores.claims.observe(() => { seams.turnClaimChanged(); });

      const budget = new MissionGovernor({
        storage: runtime.storage,
        // Per actor: mission labels are caller prose, so a shared ledger row would let
        // one actor's spend exhaust another's cap.
        actor: handle,
        pricing: (spec) => seams.pricing(spec ?? seams.hostedModel(handle)),
      });

      const engine = new EvolutionEngine(runtime, stores.history, {
        transaction: (body) => { seams.ctx.storage.transactionSync(body); },
        // Review model calls debit the mission the reviewed turn ran under.
        governor: budget,
      });

      const backendHost: BackendHost = {
        broadcast: (event) => { seams.broadcast(handle.actorId, event); },
        enqueueTurn: (input) => seams.enqueueTurn(bound, input),
        turnInFlight: () => seams.turnInFlight(bound),
        // Its queue is its event log, which never ends.
        closed: () => false,
        setTimer: (fn, ms) => { seams.setTimer(fn, ms); },
        reconcileDurableWake: () => { seams.reconcileDurableWake(); },
      };

      return {
        host: backendHost,
        engine,
        eventLog: new EventLog(seams.exec, handle),
        budget,
        refinementLane: seams.refinementLane(bound),
        sinks: runEventSinks(bound, (event, detail) => { seams.logActivity(handle.actorId, event, detail); }),
      };
    },

    /** Releases the home and state subtree on destroy only; an archived actor keeps its files. */
    advisorPort: (bound) => seams.advisorPort?.(bound.reference) ?? null,

    discardBytes: (record: WorkspaceActor): Promise<void> => {
      return settle(Effect.gen(function* () {
        const { homeName, shellId } = hostedActorPlacement(record);

        if (homeName !== null) yield* Effect.promise(async () => facetHomeReleaser(seams.homeHost())(homeName));

        seams.homes.forget(record.actorId);
        const box = seams.workspaceBox(shellId);

        // A hired-but-idle actor never materialized its subtree, so absence is swallowed.
        return yield* Effect.catchCause(Effect.gen(function* () {
          yield* Effect.promise(async () => box.files.delete(actorStateRoot(record.storageKey), { recursive: true }));
        }), (failed) => Effect.gen(function* () {
          const cause = Cause.squash(failed);

          if (!isVfsError(cause) || cause.code !== 'ENOENT') return yield* Effect.failCause(failed);
        }));
      }));
    },
  };

  host = createActorHost(deps);

  return host;
}

/** Null until the `context_edit` run-event variant exists; a recorder that cannot represent it would drop or throw. */
function contextEventsFor(_actor: BoundActor): ContextEventRecorder | null {
  return null;
}

export interface ActorRetirementRequest {
  readonly reference: ActorReference;
  readonly name: string;
  readonly keepHistory: boolean;
  readonly interrupt: boolean;
  observed?: { readonly turnId: string; readonly epoch: number };
}

/** `destroy` reclaims rows and bytes; archive keeps both. `observed` is set only when the caller saw a live claim. */
export function actorRetirementFor(input: ActorRetirementRequest): ActorRetirement {
  const retirement: ActorRetirement = {
    reference: input.reference, name: input.name, destroy: !input.keepHistory, interrupt: input.interrupt,
  };

  if (input.observed === undefined) return retirement;

  return { ...retirement, observed: input.observed };
}

/** Interrupted-turn recovery is core's `recoverActorTurns`; this backend calls it from the alarm sweep. */
