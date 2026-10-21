/**
 * Logical actors seated in the root DO: the root owns all actor SQL, scoped by `actor_id`; this module supplies each
 * actor's runtime. Every agent's turns run in its own isolate (D9), so a seat here holds no session: what a turn of its
 * reaches is built per turn (`OrchestratorAgent.actorSurface`). An actor owns its rows, its state subtree and its home
 * uid; it shares the workspace file plane (tests/unit-head-fork.test.ts) and the immutable catalogs.
 * Only an explicit cancel RPC cancels hosted work; eviction must leave it resumable.
 * Not facets: `do.facet.cpu_shared` means a facet wave serialises like one isolate.
 */

import type { ComputerProcessEnds } from '@kinu.run/core';
import type { Agent, AgentContext } from 'agents';
import {
  childContextResolver, localContextTree, type ContextEditor, type ContextTree, createSeatHost, defaultLoopOrigin,
  facetHomeProvisioner, facetHomeReleaser, actorHomeName, actorStateRoot,
  actorScaffoldPath, agentArtifactDirectory, agentHome, MAIN_AGENT, WORKSPACE_ROOT, type ActorHost,
  type SeatHostDeps, type ActorRetirement, type BoundActor, type ActorHandle, type ActorReference,
  type AgentRuntime, type DeferredApprovalChannel, type LoopOrigin,
  type ModelCallReport, type ModelOperationSink,
  type NodeHomeHost, type NodeWorkspace, type ProfileAuthorityInputs,
  type ResolvedTurnProfile, type SeatedActor, type SlateCallResult, type SlateOperation, type SqlExec,
  type SqlExecutor, type SqlValue, type WorkMode, type WorkspaceActor, type WorkspaceActorDirectory,
  type WriteObserver, actorPolicy, isSubordinateOrigin, type TierRefusals, currentOperationProfile, providerAccounts,
} from '@kinu.run/core';
import { isVfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { flight, KinuError, settle, type AgentTracing } from '@kinu.run/core/obs';
import { Cause, Effect } from 'effect';
import { createCFRuntime, type CFRuntime, type CFRuntimeHooks, type WorkspaceBoxUse } from './runtime';
import type { AdoptsJobs, CommandEnvironment, LiveRead } from '@kinu.run/core';
import type { HostedBox, HostedWorkspace } from './workspace-host';

/** The root agents-SDK members a hosted actor's runtime borrows; projected from `Agent` so upstream drift fails to compile. */
type HostRootAgent = Pick<Agent<Env>, 'name' | 'sql'>;

/** Everything the root lends hosted actors; anything absent here a child builds for itself. */
export interface WorkspaceHostSeams {
  readonly env: Env;
  readonly ctx: AgentContext;
  readonly agent: HostRootAgent;
  holdLane<T>(body: () => Promise<T>): Promise<T>;
  currentTurn(reference: ActorReference): string | null;
  /** The root's own runtime: inheriting children read the retained program from it. */
  rootRuntime(): AgentRuntime;
  /**
   * The workspace agent's placement where the workspace object is its home: seated over the workspace's own runtime.
   * Absent where no object holds it (a fixture), so it is seated as any agent is.
   */
  workspaceAgentHome?(): CFRuntime;
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
  workspaceBox(shellId: string): HostedBox;
  workspaceServing(): ReturnType<HostedWorkspace['serving']>;
  readonly commandEnvironment: CommandEnvironment;
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
  servingMoved(): Promise<void>;
  readonly boxUse: WorkspaceBoxUse;
  readonly modelOperations: ModelOperationSink;
  tracing(): AgentTracing;
  slate(actor: ActorHandle, operation: SlateOperation, turn?: string): Promise<SlateCallResult>;
  /** The owner's needs-you queue: one per workspace, which each actor parks on as itself. */
  deferrals(actorId: string): DeferredApprovalChannel | undefined;
  /** The runner `actor`'s calls become jobs on, a process it starts among them. */
  jobs(actor: BoundActor): AdoptsJobs;
  /** Where the workspace's computer processes run as jobs end. */
  processEnds(): Pick<ComputerProcessEnds, 'ended' | 'state'>;
  /** The loop origin a creation site named for this actor, or null for the kind's default. */
  chosenLoopOrigin(record: WorkspaceActor): LoopOrigin | null;
  /**
   * The write observer a run named for this actor, or null. A register filled before
   * `acquire`, like {@link chosenLoopOrigin}; never a widened core seam.
   */
  chosenWriteObserver(record: WorkspaceActor): WriteObserver | null;
}

/** An actor this workspace seats: over a runtime of its own, its turns run in its own isolate. */
export type CFSeat = SeatedActor<CFRuntime>;

/** Where a hosted actor lives: one reader. */
export interface HostedActorPlacement {
  /** A swarm node's home is in `head-`. */
  readonly homeName: string | null;
  /** Origin-prefixed: a head's and a subordinate's differ. */
  readonly shellId: string;
}

export function hostedActorPlacement(record: WorkspaceActor): HostedActorPlacement {
  if (record.origin === 'system') return { homeName: null, shellId: `agent:${record.name}` };

  return {
    homeName: actorHomeName(record),
    shellId: `${isSubordinateOrigin(record.origin) ? 'subordinate' : 'run'}:${record.storageKey}`,
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

export function createWorkspaceActorHost(seams: WorkspaceHostSeams): ActorHost<CFSeat> {
  const runtimes = new WeakMap<ActorHandle, CFRuntime>();
  let host: ActorHost<CFSeat> | null = null;

  const deps: SeatHostDeps<CFRuntime> = {
    storage: {
      sql: seams.sql,
      transactionSync: <Result>(write: () => Result): Result => seams.ctx.storage.transactionSync(write),
      // The watched executor: an actor's purge moves the reads its tables back (`watchedExec`).
      exec: (query: string, ...bindings: readonly SqlValue[]) => seams.exec.exec(query, ...bindings),
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

          return { vfs: box.store({ home: agentHome(MAIN_AGENT) }), artifactDirectory: agentArtifactDirectory(agentHome(MAIN_AGENT)) };
        }

        const home = yield* Effect.promise(async () => provisioning);

        return { vfs: box.store(home), artifactDirectory: agentArtifactDirectory(home.home) };
      }));
    },

    runtimeFor: async (bound: BoundActor): Promise<CFRuntime> => {
      // Placement from the policy: the workspace agent lives in the workspace's own runtime, which its opener holds.
      const workspaceHome = actorPolicy(bound.record).workspaceAgent ? seams.workspaceAgentHome?.() : undefined;

      if (workspaceHome !== undefined) return workspaceHome;
      const held = runtimes.get(bound.handle);

      if (held) return held;
      const home = seams.homes.get(bound.record, bound.reference);

      const hooks: CFRuntimeHooks = {
        reportModelCall: (report) => { seams.reportModelCall(report); },
        modelOperations: seams.modelOperations,
        currentTurn: (reference) => seams.currentTurn(reference),
        // Its lanes call on the account its chat does: its own choice, else the workspace's, else the catalog's.
        accounts: () => providerAccounts({
          actor: bound.handle.config.getProviderAccounts(), workspace: seams.directory.main().config.getProviderAccounts(),
          catalog: currentOperationProfile(bound.handle)?.inputs?.envelope.catalog.accounts,
        }),
        // Built with the runtime, which lives as long as this actor stays bound.
        refusals: seams.refusals(bound.handle),
        liveReadsMoved: (reads) => { seams.liveReadsMoved(reads); },
        servingMoved: () => seams.servingMoved(),
        boxUse: seams.boxUse,
        slate: (operation, turn) => seams.slate(bound.handle, operation, turn),
        // The workspace's own actor's, or a hire's: a decision wakes either. A swarm head has none, as no drain resumes it.
        deferrals: () => (bound.record.origin === 'swarm' ? undefined : seams.deferrals(bound.handle.actorId)),
        jobs: () => seams.jobs(bound),
        processEnds: () => seams.processEnds(),
        // The chat's authority: a self-resolved profile could differ from the turn's and make a search unreproducible.
        resolveProfile: async () => (await seams.resolveProfile({
          actor: bound.handle, availableTools: [], workMode: 'build',
        })).profile,
        contextPlane: {
          actorId: bound.handle.actorId,
          own: () => (bound.handle.parentActorId === null
            ? localContextTree(() => ({ claims: bound.stores.claims, events: bound.stores.eventRecorder }), { author: bound.handle.actorId, child: false })
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
        holdLane: (body) => seams.holdLane(body),
        workspaceBox: (shellId) => seams.workspaceBox(shellId),
        workspaceServing: () => seams.workspaceServing(),
        commandEnvironment: seams.commandEnvironment,
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
    scaffoldFor: async (bound) => ({ path: actorScaffoldPath(bound.record),
      vfs: seams.workspaceBox(hostedActorPlacement(bound.record).shellId).store({ home: WORKSPACE_ROOT }) }),

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

    discardBytes: (record: WorkspaceActor): Promise<void> => {
      return settle(Effect.gen(function* () {
        const { homeName, shellId } = hostedActorPlacement(record);

        if (homeName !== null) yield* Effect.promise(async () => facetHomeReleaser(seams.homeHost())(homeName));

        seams.homes.forget(record.actorId);
        const box = seams.workspaceBox(shellId);

        // A hired-but-idle actor never materialized its subtree, so absence is swallowed.
        return yield* Effect.catchCause(Effect.gen(function* () {
          yield* Effect.promise(async () => box.store({ home: WORKSPACE_ROOT }).removeRecursive(actorStateRoot(record.storageKey)));
        }), (failed) => Effect.gen(function* () {
          const cause = Cause.squash(failed);

          if (!isVfsError(cause) || cause.code !== 'ENOENT') return yield* Effect.failCause(failed);
        }));
      }));
    },
  };

  // Seated with no session: every agent's turns run in its own isolate (D9).
  host = createSeatHost<CFSeat, CFRuntime>(deps, { compose: (seated) => Effect.succeed(seated) });

  return host;
}

export interface ActorRetirementRequest {
  readonly reference: ActorReference;
  readonly name: string;
  readonly keepHistory: boolean;
  readonly interrupt: boolean;
}

/** `destroy` reclaims rows and bytes; archive keeps both. An agent's turn claim is its own isolate's, so a retirement
 *  here observes none. */
export function actorRetirementFor(input: ActorRetirementRequest): ActorRetirement {
  return { reference: input.reference, name: input.name, destroy: !input.keepHistory, interrupt: input.interrupt };
}

/** Interrupted-turn recovery is core's `recoverActorTurns`; this backend calls it from the alarm sweep. */
