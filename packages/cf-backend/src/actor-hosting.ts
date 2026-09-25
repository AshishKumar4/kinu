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
  childContextResolver, createActorHost, defaultLoopOrigin,
  EvolutionEngine, EventLog, MissionGovernor,
  facetHomeProvisioner, facetHomeReleaser, isVfsError,
  headAgentName, subordinateAgentName, parseActorKey,
  actorStateRoot, actorScaffoldPath,
  nimbusSessionFiles, agentArtifactDirectory, agentHome, MAIN_AGENT,
  type ActorHost, type ActorHostDeps, type ActorRetirement, type BoundActor,
  type ActorHandle, type ActorReference, type AgentOrchestratorDeps, type AgentRuntime,
  type BackendHost, type BroadcastEvent, type ContextEventRecorder,
  type DeferredApprovalChannel, type EnqueueTurnResult,
  type LoopOrigin, type ModelCallReport,
  type ModelOperationSink, type ModelPricing, type NimbusSandboxHandle, type NodeHomeHost,
  type NodeWorkspace,
  type ProfileAuthorityInputs, type ProgrammaticTurn, type ResolvedTurnProfile,
  type RunEventInput,
  type SlateCallResult, type SlateOperation, type SqlExec, type SqlExecutor,
  type SqlValue, type WorkMode,
  type WorkspaceActor, type WorkspaceActorDirectory, type WriteObserver,
} from '@kinu.run/core';
import { diagnostics, KinuError, toKinuError } from '@kinu.run/core/obs';
import { createCFRuntime, type CFRuntime, type CFRuntimeHooks } from './runtime';
import type { HostedNodeHome } from '@kinu.run/core';

/** The root agents-SDK members a hosted actor's runtime borrows; projected from `Agent` so upstream drift fails to compile. */
export type HostRootAgent = Pick<Agent<Env>, 'name' | 'sql' | 'runFiber'>;

/** Everything the root lends hosted actors; anything absent here a child builds for itself. */
export interface WorkspaceHostSeams {
  readonly env: Env;
  readonly ctx: AgentContext;
  readonly agent: HostRootAgent;
  /** The root's own runtime: inheriting children read the retained program from it. */
  rootRuntime(): AgentRuntime;
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
  /** The profile authority chats resolve through, so role restrictions narrow heads, nodes and subordinates identically. */
  resolveProfile(input: {
    readonly actor: ActorHandle;
    readonly availableTools: readonly string[];
    readonly workMode: WorkMode;
  }): Promise<{ readonly profile: ResolvedTurnProfile; readonly inputs: ProfileAuthorityInputs }>;
  reportModelCall(report: ModelCallReport): void;
  readonly modelOperations: ModelOperationSink;
  pricing(): ModelPricing | null;
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
  slate(actor: ActorHandle, operation: SlateOperation): Promise<SlateCallResult>;
  /** The owner's needs-you queue: one per workspace. */
  deferrals(): DeferredApprovalChannel | undefined;
  refinementLane(bound: BoundActor & { readonly runtime: AgentRuntime }): () => Promise<void>;
  /** The loop origin a creation site named for this actor, or null for the kind's default. */
  chosenLoopOrigin(record: WorkspaceActor): LoopOrigin | null;
  /**
   * The write observer a run named for this actor, or null. A register filled before
   * `acquire`, like {@link chosenLoopOrigin}; never a widened core seam.
   */
  chosenWriteObserver(record: WorkspaceActor): WriteObserver | null;
}

/** An MCTS branch acquires no execution plane; a swarm node's home is in `head-`. */
export type HostedActorHomeKind = 'head' | 'subordinate';

function hostedActorAgentName(kind: HostedActorHomeKind, id: string): string {
  switch (kind) {
    case 'head': return headAgentName(id);
    case 'subordinate': return subordinateAgentName(id);
  }
}

function hostedHomeKind(record: WorkspaceActor): HostedActorHomeKind | null {
  if (record.kind === 'main' || record.kind === 'branch') return null;

  return record.kind;
}

/** Kind-prefixed so a head's and a subordinate's shell state cannot collide on one id. */
function hostedActorShellId(record: WorkspaceActor): string {
  if (record.kind === 'main') return `agent:${record.name}`;

  return `${record.kind}:${record.storageKey}`;
}

/**
 * Provision one hosted actor's home. The single implementation: the swarm's
 * `provisionNodeHome` must report the same home. Keyed on the storage key, never a raw id.
 */
export async function provisionHostedActorHome(
  seams: Pick<WorkspaceHostSeams, 'homeHost' | 'directory'>,
  record: WorkspaceActor,
  reference: ActorReference,
  kind: HostedActorHomeKind,
): Promise<NodeWorkspace> {
  const path = seams.directory.storagePath(reference);
  const provision = facetHomeProvisioner(seams.homeHost(), () => { seams.directory.validate(reference, path); });

  return await provision(hostedActorAgentName(kind, parseActorKey(record.storageKey).id));
}

/** Build the workspace's one actor host over the root's `Storage` (open-38). */
export function createWorkspaceActorHost(seams: WorkspaceHostSeams): ActorHost {
  const runtimes = new WeakMap<ActorHandle, CFRuntime>();
  /** Per-activation round-trip saver; provisioning is idempotent, so never a source of truth. */
  const homes = new Map<string, Promise<HostedNodeHome>>();
  /** Bumped per attempt so a failing provision only clears the entry it wrote. */
  const homeGeneration = new Map<string, number>();
  let host: ActorHost | null = null;

  const homeFor = (record: WorkspaceActor, reference: ActorReference): Promise<HostedNodeHome> | null => {
    const kind = hostedHomeKind(record);

    if (kind === null) return null;
    const held = homes.get(record.actorId);

    if (held) return held;
    // Cleanup rethrows so the stored promise still rejects for the acquire awaiting it;
    // the generation stamp keeps a failure from clearing a newer attempt's entry.
    const generation = (homeGeneration.get(record.actorId) ?? 0) + 1;
    homeGeneration.set(record.actorId, generation);

    const provisioning = (async (): Promise<HostedNodeHome> => {
      try {
        const home = await provisionHostedActorHome(seams, record, reference, kind);

        if (home.isolation !== 'private-home') throw new KinuError('denied', 'A hosted actor requires its own credential.');

        return { home: home.home, tmp: home.tmp, cred: home.cred };
      } catch (cause) {
        if (homeGeneration.get(record.actorId) === generation) homes.delete(record.actorId);
        throw cause;
      }
    })();

    homes.set(record.actorId, provisioning);

    return provisioning;
  };

  const deps: ActorHostDeps = {
    storage: {
      sql: seams.sql,
      transactionSync: <Result>(write: () => Result): Result => seams.ctx.storage.transactionSync(write),
      exec: (query: string, ...bindings: readonly SqlValue[]) => seams.ctx.storage.sql.exec(query, ...bindings),
    },
    directory: seams.directory,
    installedBuild: seams.installedBuild(),
    filesFor: async (bound) => {
      const provisioning = homeFor(bound.record, bound.reference);
      const box = seams.workspaceBox(hostedActorShellId(bound.record));

      if (provisioning === null) {
        if (bound.record.kind !== 'main') throw new KinuError('denied', 'Actor has no credentialed artifact home');

        return { vfs: nimbusSessionFiles(box), artifactDirectory: agentArtifactDirectory(agentHome(MAIN_AGENT)) };
      }

      const home = await provisioning;

      return { vfs: nimbusSessionFiles(box, home.cred), artifactDirectory: agentArtifactDirectory(home.home) };
    },

    runtimeFor: async (bound: BoundActor): Promise<AgentRuntime> => {
      const held = runtimes.get(bound.handle);

      if (held) return held;
      const home = homeFor(bound.record, bound.reference);

      const hooks: CFRuntimeHooks = {
        reportModelCall: (report) => { seams.reportModelCall(report); },
        slate: (operation) => seams.slate(bound.handle, operation),
        deferrals: () => seams.deferrals(),
        // The chat's authority: a self-resolved profile could differ from the turn's and make a search unreproducible.
        resolveProfile: async () => (await seams.resolveProfile({
          actor: bound.handle, availableTools: [], workMode: 'build',
        })).profile,
        contextPlane: {
          actorId: bound.handle.actorId,
          claims: () => bound.stores.claims,
          // Null until the `context_edit` run-event variant exists; see contextEventsFor.
          events: () => null,
          children: childContextResolver({
            host: { bindStores: (reference) => host?.bindStores(reference) ?? bound },
            directory: seams.directory,
            parent: bound.handle,
            events: (child) => contextEventsFor(child),
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
        rootActor: bound.record.kind === 'main',
        ownerUserId: () => seams.ownerUserId(),
        shellId: hostedActorShellId(bound.record),
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
      const origin = seams.chosenLoopOrigin(bound.record) ?? defaultLoopOrigin(bound.record.kind);

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
        pricing: () => seams.pricing(),
      });

      const engine = new EvolutionEngine(runtime, stores.history, {
        transaction: (body) => { seams.ctx.storage.transactionSync(body); },
        // Review model calls debit the mission the reviewed turn ran under.
        governor: budget,
        reportModelCall: (report) => { seams.reportModelCall(report); },
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

      // A failed recording is reported, never thrown: losing an event must not end the turn.
      const recordRunEvent = (input: HostedRunEvent): void => {
        const runId = activeRunOf(stores);

        if (runId === null) return;

        try {
          stores.eventRecorder.emit(runId, input);
        } catch (cause) {
          diagnostics.failure(RUN_EVENT_EMIT_FAILED[input.type], toKinuError({
            doing: `recording a hosted actor ${input.type} run event`, cause, otherwise: 'io',
          }), { actor: handle.name });
        }
      };

      return {
        host: backendHost,
        engine,
        eventLog: new EventLog(seams.exec, handle),
        budget,
        refinementLane: seams.refinementLane(bound),
        sinks: {
          logActivity: (event, detail) => { seams.logActivity(handle.actorId, event, detail); },
          onToolCallEvent: (event) => { recordRunEvent({ type: 'tool_call_end', ...event }); },
          onStepEvent: (event) => { recordRunEvent({ type: 'step_finish', ...event }); },
        },
      };
    },

    /** Releases the home and state subtree on destroy only; an archived actor keeps its files. */
    discardBytes: async (record: WorkspaceActor): Promise<void> => {
      const kind = hostedHomeKind(record);

      if (kind !== null) {
        await facetHomeReleaser(seams.homeHost())(hostedActorAgentName(kind, parseActorKey(record.storageKey).id));
      }

      homes.delete(record.actorId);
      const box = seams.workspaceBox(hostedActorShellId(record));

      // A hired-but-idle actor never materialized its subtree, so absence is swallowed.
      try {
        await box.files.delete(actorStateRoot(record.storageKey), { recursive: true });
      } catch (cause) {
        if (!isVfsError(cause) || cause.code !== 'ENOENT') throw cause;
      }
    },
  };

  host = createActorHost(deps);

  return host;
}

/** Null until the `context_edit` run-event variant exists; a recorder that cannot represent it would drop or throw. */
function contextEventsFor(_actor: BoundActor): ContextEventRecorder | null {
  return null;
}

/**
 * The actor's newest unsettled claim, read from the ledger so it survives eviction.
 * No active run drops the event: a row keyed on '' would join to every actor.
 */
function activeRunOf(stores: BoundActor['stores']): string | null {
  return stores.claims.unsettled(1)[0]?.runId ?? null;
}

type HostedRunEvent = Extract<RunEventInput, { type: 'tool_call_end' | 'step_finish' }>;

/** Written out so a lost recording stays greppable. */
const RUN_EVENT_EMIT_FAILED = {
  tool_call_end: 'event.tool_call_end_emit_failed',
  step_finish: 'event.step_finish_emit_failed',
} as const;

export interface ActorRetirementRequest {
  readonly reference: ActorReference;
  readonly name: string;
  readonly keepHistory: boolean;
  observed?: { readonly turnId: string; readonly epoch: number };
}

/** `destroy` reclaims rows and bytes; archive keeps both. `observed` is set only when the caller saw a live claim. */
export function actorRetirementFor(input: ActorRetirementRequest): ActorRetirement {
  const retirement: ActorRetirement = {
    reference: input.reference, name: input.name, destroy: !input.keepHistory,
  };

  if (input.observed === undefined) return retirement;

  return { ...retirement, observed: input.observed };
}

/** Interrupted-turn recovery is core's `recoverActorTurns`; this backend calls it from the alarm sweep. */
