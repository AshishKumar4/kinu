/**
 * ONE workspace database, many logical actors — the cf side of it.
 *
 * WHAT THIS REPLACES. Every non-root actor in a cf workspace used to be an
 * agents-SDK FACET: a co-located child Durable Object with its own SQLite, its
 * own `initActorStateSchema`, its own identity row, its own activation row and
 * its own model-operation outbox. That bought a storage boundary and a teardown
 * verb and nothing else — `do.facet.cpu_shared` means a wave of facets
 * serialises exactly as one isolate's `Promise.allSettled` already did, which
 * this tree had already written down (the old `getCFNodeHost` header). What it
 * COST was a per-facet database charged against the root's shared quota with a
 * reset — not a catchable error — at the wall, a 65,536-facets-per-DO lifetime
 * cap reached on the default path, a bootstrap/discard/reclaim family whose
 * only job was to keep those databases from leaking, and a second copy of every
 * store, ledger and policy the root already had. A subordinate's ledgers were
 * unreadable from the workspace that owned it; a depth-2 head's journal rows
 * landed in a database the surface could not join against.
 *
 * WHAT IT IS NOW. The root Durable Object owns ALL actor SQL. A hired
 * subordinate, an ask-by-role temporary, a branching head, a swarm node and an
 * MCTS rollout branch are LOGICAL actors: rows in `workspace_actors`, stores
 * scoped by `actor_id` over the root's one `Storage`, and their own runtime
 * objects — session, stores, queue, abort, roles, alarms — under the root's
 * lifecycle. `createActorHost` in core owns the fencing, the per-actor
 * serialisation, the loop seed and the session; this module owns the two things
 * only this backend can answer: what an actor's RUNTIME is here (which file
 * plane, which home, which scaffold path, which shell), and what its
 * ORCHESTRATION is here (its own event log, evolution engine, broadcast and
 * mission governor — never the root's objects).
 *
 * WHAT AN ACTOR STILL OWNS ALONE, and what it now shares:
 *
 *   own    `actor_id`-scoped rows in the root's database: transcript, claims,
 *          scaffold versions, config, facts, tasks, jobs, journal, event log.
 *   own    an agent-state VFS subtree, `.kinu/agents/<storage-key>/` — its
 *          scaffold, its views, its private notes.
 *   own    a home on the workspace session (`sub-<slug>`, `head-<id>`,
 *          `node-<id>`) with its own uid, so its commands and its file tools
 *          carry ONE credential and it can neither read nor write a sibling's.
 *   shared the workspace file plane. This is the point of a subordinate: it
 *          works in the workspace it was hired into. A child that composed a
 *          filesystem of its own would get a SECOND, EMPTY one, which is the
 *          regression tests/unit-head-fork.test.ts has always pinned.
 *   shared the container, the preview ports, the Nimbus session, the provider
 *          registry and the resolved turn profile — every immutable catalog.
 *
 * CANCELLATION. Nothing in here observes a client. A hosted actor's work is
 * cancelled by an explicit cancel RPC and by nothing else: a websocket close, a
 * request abort or an evicted isolate must leave the work running or leave it
 * RESUMABLE, never cancelled. Recovery after eviction is `host.resumable()` on
 * the normal activation and alarm path, verified against the claimed program —
 * no `waitUntil`, no timer holding a lifetime open.
 */

import type { Agent, AgentContext } from 'agents';
import {
  childContextResolver, createActorHost, defaultLoopOrigin,
  EvolutionEngine, EventLog, MissionGovernor,
  facetHomeProvisioner, facetHomeReleaser, isVfsError,
  headAgentName, subordinateAgentName, parseActorKey,
  actorStateRoot, actorScaffoldPath,
  type ActorHost, type ActorHostDeps, type ActorRetirement, type BoundActor,
  type ActorHandle, type ActorReference, type AgentOrchestratorDeps, type AgentRuntime,
  type BackendHost, type BroadcastEvent, type ContextEventRecorder,
  type DeferredApprovalChannel, type EnqueueTurnResult,
  type HeadRuntime, type LoopOrigin, type ModelCallReport,
  type ModelOperationSink, type ModelPricing, type NimbusSandboxHandle, type NodeHomeHost,
  type NodeWorkspace,
  type ProfileAuthorityInputs, type ProgrammaticTurn, type ResolvedTurnProfile,
  type SlateCallResult, type SlateOperation, type SqlExec, type SqlExecutor,
  type SqlValue, type WorkMode,
  type WorkspaceActor, type WorkspaceActorDirectory, type WriteObserver,
} from '@kinu.run/core';
import { diagnostics, KinuError, toKinuError } from '@kinu.run/core/obs';
import { createCFRuntime, type CFRuntime, type CFRuntimeHooks } from './runtime';
import type { HostedNodeHome } from './node-home';

/**
 * The agents-SDK members a hosted actor's runtime reaches on the ROOT object it
 * lives inside.
 *
 * Three members, and the narrowness is the point: a hosted actor is not an
 * `Agent`, so the only agent surface in play is the root's, and this names
 * exactly the part of it a child's runtime borrows. Projected FROM the SDK's own
 * `Agent` rather than restated, so a signature bump upstream is a compile error
 * here instead of a structural mismatch at the one call site that passes `this`.
 */
export type HostRootAgent = Pick<Agent<Env>, 'name' | 'sql' | 'runFiber'>;

/**
 * Everything the root lends the actors it hosts.
 *
 * One interface rather than a pile of constructor arguments because the LIST is
 * the contract: these are the root's objects a child may borrow, and anything
 * absent here is something a child must build for itself. The two halves are
 * deliberately different in kind — immutable catalogs (env, box, profile
 * authority, provider registry) are shared by value, while everything that
 * ACCUMULATES per actor (event log, engine, governor, broadcast) is built per
 * actor inside this module and is never the root's own object.
 */
export interface WorkspaceHostSeams {
  readonly env: Env;
  readonly ctx: AgentContext;
  readonly agent: HostRootAgent;
  /**
   * The workspace ROOT's own runtime — this object's.
   *
   * Not the root's borrowed by a child, but the parent an inheriting child
   * reads its retained program from. Needed because inheritance consumes
   * durable state (handle, `scaffold_versions`, state files) rather than a live
   * activation, and nothing in production acquires main. The cli's `loopFor`
   * passes exactly this value.
   */
  rootRuntime(): AgentRuntime;
  /** The ONE workspace database. Every hosted actor's stores are scoped views
   *  over exactly this handle. */
  readonly sql: SqlExecutor;
  /** The POSITIONAL executor. Distinct from `sql` above and both are needed:
   *  the stores take a tagged template, while the event log and the archive
   *  reader compose the statements they run. Same database either way. */
  readonly exec: SqlExec;
  readonly directory: WorkspaceActorDirectory;
  /** The REGISTERED workspace name — the file plane's key, and never a child's
   *  own name. A self-named child derives a second, empty filesystem. */
  readonly workspaceName: string;
  /** The build the root publishes for its BUILTIN loop, pinned into every claim
   *  so a promoted program and a shipped one stay distinguishable. */
  installedBuild(): string | null;
  ownerUserId(): string | null;
  capabilityToken(): string | null;
  /** The workspace's own box. Shared by every hosted actor: this is the plane a
   *  subordinate was hired to work in. */
  workspaceBox(shellId: string): NimbusSandboxHandle;
  /** The uid-0 view, principal registry and uid table a home is applied with —
   *  all the root's own, which is why homes are provisioned in this isolate. */
  homeHost(): Promise<NodeHomeHost>;
  /**
   * THE profile authority — the same one an actor chat resolves through.
   *
   * A head, a node and a delegated subordinate turn all resolve here, so a role
   * restriction that narrows a chat narrows them identically, and one search's
   * branches cannot run under a profile the workspace never resolved. Takes the
   * turn's reachable tools and work mode because that is what the authority
   * reads; returns the inputs beside the profile because the claim records both.
   */
  resolveProfile(input: {
    readonly actor: ActorHandle;
    readonly availableTools: readonly string[];
    readonly workMode: WorkMode;
  }): Promise<{ readonly profile: ResolvedTurnProfile; readonly inputs: ProfileAuthorityInputs }>;
  /** Where a hosted actor's model spend is filed: the workspace total, because
   *  that is the only place a workspace's cost is assembled. */
  reportModelCall(report: ModelCallReport): void;
  readonly modelOperations: ModelOperationSink;
  /** Model pricing for the actor's own mission ledger. */
  pricing(): ModelPricing | null;
  /** Client fan-out, stamped with the actor the frame belongs to so a
   *  subordinate's pane and the workspace's pane are never one stream. */
  broadcast(actorId: string, event: BroadcastEvent): void;
  /** Serialize a programmatic turn for one hosted actor. The root owns
   *  admission; the actor's own event log is the durable queue. */
  enqueueTurn(actor: BoundActor, input: ProgrammaticTurn): Promise<EnqueueTurnResult>;
  /** Is THIS actor mid-turn. Per actor, because `host.run` serializes per actor
   *  and nothing else. */
  turnInFlight(actorId: string): boolean;
  /** The drain-debounce timer, held open by the root's activation. */
  setTimer(fn: () => Promise<void>, ms: number): void;
  /** Re-derive the root's durable wake. A hosted actor has no alarm slot of its
   *  own — the root owns the one alarm and every actor's deadline folds into
   *  it — so this is how a child's pending reaction gets a wake at all. */
  reconcileDurableWake(): void;
  /** The head runtime a hosted actor splits through, or undefined before the
   *  workspace is claimed. */
  headRuntimeFor(bound: BoundActor & { readonly runtime: AgentRuntime }): HeadRuntime | undefined;
  /** This actor's activity rows, on the workspace's one activity log. */
  logActivity(actorId: string, event: string, detail?: string): void;
  /** The workspace's slate router, as this actor. */
  slate(actor: ActorHandle, operation: SlateOperation): Promise<SlateCallResult>;
  /** The owner's needs-you queue. ONE queue per workspace: a hosted actor that
   *  parked a decision on itself would park it where nobody looks. */
  deferrals(): DeferredApprovalChannel | undefined;
  /** The refinement lane one off-turn cadence pass drives, for this actor. */
  refinementLane(bound: BoundActor & { readonly runtime: AgentRuntime }): () => Promise<void>;
  /**
   * The loop origin a creation site NAMED for this actor, or null when it named
   * none and the kind's default stands.
   *
   * The register lives on the ROOT because the creation site does: `hire`,
   * `ask`, a split and a search all decide what their children should think
   * with, and the host asks that question back at first acquire.
   */
  chosenLoopOrigin(record: WorkspaceActor): LoopOrigin | null;
  /**
   * The write observer a RUN named for this actor, or null when none did.
   *
   * THE SAME SHAPE AS {@link chosenLoopOrigin}, and for the same structural
   * reason: the host builds the runtime, only the CALLER knows something that
   * runtime needs, and `ActorHostDeps.runtimeFor` deliberately takes the
   * binding and nothing the caller invented. So the answer is a register the
   * caller fills before `acquire` and this reads — never a widened core seam.
   * The cli states the same rule over its own slot (`local-session.ts`'s
   * `pendingWriteObserver`).
   *
   * What fills it is a head run's own `HeadCapture.files`: file attribution is
   * per RUN over that actor's own workspace view, so it can be a property of
   * neither the actor nor this workspace. Null leaves the actor's file plane
   * unwatched, which is every actor but a head reporting what it changed.
   */
  chosenWriteObserver(record: WorkspaceActor): WriteObserver | null;
}

/** The home kinds the workspace provisions credentials for. A branch is not
 *  one: an MCTS rollout is toolless and acquires no execution plane at all. A
 *  swarm node's actor is a head, so its home lives in the `head-` namespace. */
export type HostedActorHomeKind = 'head' | 'subordinate';

/** The one home namespace, by kind: `head-<id>`, `sub-<slug>`.
 *  Derived from the kind and the id the directory holds, so an actor names what
 *  it IS and never the directory it wants. */
function hostedActorAgentName(kind: HostedActorHomeKind, id: string): string {
  switch (kind) {
    case 'head': return headAgentName(id);
    case 'subordinate': return subordinateAgentName(id);
  }
}

/** Which actor kinds own a home. `main` runs as the session user — the tree is
 *  its own — and a branch acquires no plane, so neither has one. */
function hostedHomeKind(record: WorkspaceActor): HostedActorHomeKind | null {
  if (record.kind === 'main' || record.kind === 'branch') return null;

  return record.kind;
}

/**
 * An actor's own state subtree and its scaffold path are CORE's
 * `actorStateRoot` / `actorScaffoldPath` now, imported below.
 *
 * They were this file's, and the copies had already drifted the dangerous way:
 * `core/src/runtime-builder.ts` hardcoded `scaffold/agent.js` for every actor,
 * so on the CLI a head's promoted source landed on its PARENT's file and the
 * parent went on to execute it — silently, because the scaffold read falls back
 * to the live view when an actor has no versioned file of its own. The agent
 * state plane is SHARED by construction, so this path is the only thing keeping
 * two actors' programs apart, and a second copy of that rule was a second
 * chance to lose it.
 */

/** The shell state an actor's commands accumulate under. Kind-prefixed so a
 *  head's cwd and a subordinate's cannot collide on one id. */
function hostedActorShellId(record: WorkspaceActor): string {
  if (record.kind === 'main') return `agent:${record.name}`;

  return `${record.kind}:${record.storageKey}`;
}

/**
 * Provision ONE hosted actor's private home, keyed on the actor's storage key.
 *
 * The ONE implementation, because there are two callers and they must not
 * disagree: the host builds every hosted actor's runtime over this, and the
 * swarm's `provisionNodeHome` seam reports the same home to the node so the
 * boundary a node is TOLD about is the boundary it actually has. A second
 * provisioner beside this one would key its own way, and two keys means two
 * homes for one actor.
 *
 * KEYED ON THE STORAGE KEY, never on a raw node or head id: an actor's home
 * has to follow the identity the directory issued, so a rename does not move it
 * and two actors that briefly shared a name across a retirement never share a
 * directory. Returns the full {@link NodeWorkspace} — `isolation` included —
 * because the swarm seam reports that value and must not restate it.
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

/**
 * Build the workspace's ONE actor host.
 *
 * `storage` is the root's own `Storage` — the single physical database of the
 * whole workspace. There is no second one to pass, which is the property
 * open-38 exists to make structural rather than agreed.
 */
export function createWorkspaceActorHost(seams: WorkspaceHostSeams): ActorHost {
  const runtimes = new WeakMap<ActorHandle, CFRuntime>();
  /** Homes in flight or applied, per actor id, for this activation only.
   *  Provisioning is idempotent — a re-entry finds the home it already had —
   *  so this is a round-trip saver and never a source of truth. */
  const homes = new Map<string, Promise<HostedNodeHome>>();
  /** Which provision attempt owns this actor's entry in `homes`. Bumped per
   *  attempt so a failing provision only clears the entry it wrote, never a
   *  newer one that replaced it while it was in flight. */
  const homeGeneration = new Map<string, number>();
  /** Assigned once, immediately below. `loopFor` needs to reach the parent
   *  actor the host itself binds, which is a question only the host can answer,
   *  so the dep closes over the host it belongs to. */
  let host: ActorHost | null = null;

  const homeFor = (record: WorkspaceActor, reference: ActorReference): Promise<HostedNodeHome> | null => {
    const kind = hostedHomeKind(record);

    if (kind === null) return null;
    const held = homes.get(record.actorId);

    if (held) return held;
    // The cleanup is INSIDE the provision and rethrows, so the stored promise
    // still rejects for whoever is awaiting it and there is no floating promise
    // whose rejection is dropped. The `throw` is what hands the fault to the
    // acquire that asked for the home.
    //
    // A failed provision must not be remembered as this actor's home: the next
    // acquire re-applies it rather than refusing forever on a fault that passed.
    // A GENERATION STAMP rather than comparing against the promise itself: the
    // map may already hold a newer attempt by the time this one fails, and the
    // stamp answers "is the entry still mine" without the provision having to
    // name its own promise — which would need the binding before it exists.
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

    /**
     * The actor's runtime, over the handle the host bound.
     *
     * Three facts, and they are the whole of what makes this actor distinct: its
     * OWN agent-state subtree and scaffold path, its OWN home credential on both
     * planes, and the SHARED workspace file plane it was hired into. Everything
     * else — the box, the provider registry, the profile authority — is the
     * root's, borrowed by value.
     */
    runtimeFor: async (bound: BoundActor): Promise<AgentRuntime> => {
      const held = runtimes.get(bound.handle);

      if (held) return held;
      const home = homeFor(bound.record, bound.reference);

      const hooks: CFRuntimeHooks = {
        reportModelCall: (report) => { seams.reportModelCall(report); },
        slate: (operation) => seams.slate(bound.handle, operation),
        deferrals: () => seams.deferrals(),
        // The SAME authority a chat resolves through, narrowed to this actor. A
        // head that resolved its own profile could land a different provider
        // revision and a different digest from the turn it belongs to, which is
        // the one thing that makes a search unreproducible.
        resolveProfile: async () => (await seams.resolveProfile({
          actor: bound.handle, availableTools: [], workMode: 'build',
        })).profile,
        // The per-step context plane as FILES, mounted for this actor and for
        // whatever it hires or splits into. The children resolver is the host's
        // own binder, so a child's stores are opened under the directory's
        // authority and never by a caller that merely knows an id.
        contextPlane: {
          actorId: bound.handle.actorId,
          claims: () => bound.stores.claims,
          // Null until the `context_edit` run-event variant lands beside the
          // recorder: `RunEventRecorder` satisfies the plane's port the moment
          // it does, with no adapter and no cast. Null records nothing rather
          // than claiming an emission nobody would receive.
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
      // THE WATCHER THE RUN NAMED, when a run named one. Assigned rather than
      // declared in the literal above for the same reason the home is:
      // `createCFRuntime` reads PRESENCE to decide whether this actor's own
      // file view is wrapped at all, so absent has to be an absent key rather
      // than a key holding undefined. Read here and not earlier because this
      // is the one place that builds the plane the writes land on — a head's
      // `HeadReport.fileChanges` is its capture's snapshot and nothing else
      // fills it, so a runtime built past this line unwatched reports that the
      // head changed nothing however much it wrote.
      const writes = seams.chosenWriteObserver(bound.record);

      if (writes !== null) hooks.workspaceObserver = writes;

      const runtime = createCFRuntime(seams.agent, {
        env: seams.env,
        ctx: seams.ctx,
        workspaceBox: (shellId) => seams.workspaceBox(shellId),
      }, {
        actor: bound.handle,
        // NOT this actor's own name. The file plane is keyed by the registered
        // workspace, so a self-named child derives a second, empty filesystem.
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
     * WHAT LOOP THIS ACTOR THINKS WITH, and whose it came from.
     *
     * The host seeds before it constructs the session, so an unseeded hosted
     * actor is unrepresentable. The default is not uniform and that is the
     * policy: a head and a branch INHERIT the parent's promoted loop,
     * because a fork of an actor's reasoning that ran a fresh v0 would be a fork
     * of nothing the actor had learned. A hired subordinate starts BUILTIN — it
     * is a new colleague with its own role, and inheriting a program tuned for
     * someone else's role is the misevolution the gate exists to prevent.
     *
     * `parent` is the parent whose DURABLE state inheritance can be read from,
     * which is a different question from "is the parent hosted right now".
     * `inheritedSource` consumes exactly three things — the parent's bound
     * handle, its `scaffold_versions` rows and its state VFS — and none of them
     * needs a live activation. The workspace ROOT always has all three because
     * it IS this object's own runtime, and every head and branch registers
     * under main, so asking only `hosted()` refused the FIRST fork in a fresh
     * workspace: nothing in production acquires main, so `seedActorLoop` threw
     * `bad_input` on a parent that was reachable all along. The cli passes its
     * own runtime unconditionally for this reason.
     *
     * A deeper parent — a head under a hired subordinate — still needs to be
     * live, and when it is not the null stands and the guard refuses, naming
     * what could not be reached. That refusal is deliberately NOT softened into
     * "keep the pointer or start builtin": a fork silently started on the
     * builtin loop would not be a fork of this agent, which fails as a wrong
     * program instead of as an error.
     */
    loopFor: async (bound) => {
      const origin = seams.chosenLoopOrigin(bound.record) ?? defaultLoopOrigin(bound.record.kind);

      if (origin.kind !== 'inherit' || bound.record.parentActorId === null || host === null) {
        return { origin, parent: null };
      }

      const parentRecord = host.describe(bound.record.parentActorId);

      if (parentRecord === null) return { origin, parent: null };

      // The root is the only actor with no parent of its own, and it is always
      // reachable: this host lives inside it.
      if (parentRecord.parentActorId === null) return { origin, parent: seams.rootRuntime() };

      const live = host.hosted({
        actorId: parentRecord.actorId,
        workspaceId: parentRecord.workspaceId,
        parentActorId: parentRecord.parentActorId,
      });

      return { origin, parent: live === null ? null : live.runtime };
    },

    /**
     * WHERE A CONTEXT EDIT'S EVIDENCE GOES, per actor.
     *
     * Per actor and not per workspace, because a context edit is evidence about
     * the actor whose context MOVED — including when an authorized parent made
     * it — and the two events it produces (`staged` at authoring, `activated`
     * at the boundary that took it) belong on that actor's run.
     *
     * See {@link contextEventsFor} for why this tree answers null.
     */
    contextEvents: (bound) => contextEventsFor(bound),

    /**
     * The actor's OWN orchestration — never the root's objects.
     *
     * This is the half that used to be impossible without a second database.
     * The event log is this actor's inbox (a delegated task admitted for a
     * subordinate must not drain on the workspace), the engine grades this
     * actor's turns against this actor's scaffold, the governor charges this
     * actor's mission ledger, and the broadcast is stamped with this actor so
     * its pane is its own. All of them are built here, per actor, over the
     * root's one handle.
     */
    orchestrationFor: (bound): AgentOrchestratorDeps => {
      const { runtime, stores, handle } = bound;

      const budget = new MissionGovernor({
        storage: runtime.storage,
        // PER ACTOR, and it is this actor's own fenced handle rather than the
        // root's: a mission label is caller-authored prose, so two actors of
        // one workspace declare the same one, and a shared ledger row would
        // have one actor's spend exhaust the other's cap.
        actor: handle,
        pricing: () => seams.pricing(),
      });

      const engine = new EvolutionEngine(runtime, {
        enabled: true,
        // The grading group as ONE unit. A synchronous run inside a Durable
        // Object is already atomic; answering through the platform's own
        // primitive keeps it so whatever core comes to put between the
        // statements.
        transaction: (body) => { seams.ctx.storage.transactionSync(body); },
        // The review's own model calls debit the mission the reviewed turn ran
        // under — the same ledger, through the same seam, as the work it
        // reviews. Unbudgeted turns never reach it.
        governor: budget,
      });

      const host: BackendHost = {
        broadcast: (event) => { seams.broadcast(handle.actorId, event); },
        enqueueTurn: (input) => seams.enqueueTurn(bound, input),
        turnInFlight: () => seams.turnInFlight(handle.actorId),
        setTimer: (fn, ms) => { seams.setTimer(fn, ms); },
        // A hosted actor has no alarm slot: the root owns the one alarm and
        // every actor's deadline folds into it, so this is how a child's
        // pending reaction gets a wake with nobody watching.
        reconcileDurableWake: () => { seams.reconcileDurableWake(); },
        get headRuntime() { return seams.headRuntimeFor(bound); },
      };

      return {
        host,
        engine,
        eventLog: new EventLog(seams.exec, handle),
        budget,
        refinementLane: seams.refinementLane(bound),
        sinks: {
          logActivity: (event, detail) => { seams.logActivity(handle.actorId, event, detail); },
          onToolCallEvent: (event) => {
            const runId = activeRunOf(stores);

            if (runId === null) return;

            try {
              stores.eventRecorder.emit(runId, { type: 'tool_call_end', ...event });
            } catch (cause) {
              diagnostics.failure('event.tool_call_end_emit_failed', toKinuError({
                doing: 'recording a hosted actor tool_call_end run event', cause, otherwise: 'io',
              }), { actor: handle.name });
            }
          },
          onStepEvent: (event) => {
            const runId = activeRunOf(stores);

            if (runId === null) return;

            try {
              stores.eventRecorder.emit(runId, { type: 'step_finish', ...event });
            } catch (cause) {
              diagnostics.failure('event.step_finish_emit_failed', toKinuError({
                doing: 'recording a hosted actor step_finish run event', cause, otherwise: 'io',
              }), { actor: handle.name });
            }
          },
        },
      };
    },

    /**
     * The bytes OUTSIDE sql, on destroy only.
     *
     * SQL rows are the host's to cut — it holds the one database and does it in
     * the retirement transaction. What it cannot reach is this actor's home on
     * the Nimbus session and its state subtree on the workspace tree, and both
     * are real bytes that outlive the row. Released here, and ONLY for a
     * destroy: an archived actor keeps its history, which means keeping the
     * files that history refers to.
     */
    discardBytes: async (record: WorkspaceActor): Promise<void> => {
      const kind = hostedHomeKind(record);

      if (kind !== null) {
        await facetHomeReleaser(seams.homeHost())(hostedActorAgentName(kind, parseActorKey(record.storageKey).id));
      }

      homes.delete(record.actorId);
      const box = seams.workspaceBox(hostedActorShellId(record));

      // A hired-but-idle actor never materialized its state subtree: wiping it
      // is still a wipe, not an error — dismissal without a first turn is
      // ordinary — so absence is swallowed and anything else travels.
      //
      // `isVfsError` is core's own guard over the file plane's error contract:
      // it establishes that this is an `Error` whose `code` is one of the
      // declared errno values, so the comparison is against a domain code
      // rather than a shape sniffed at runtime. Anything that is not a VFS
      // error at all travels untouched, which is what a fault in the box
      // itself should do.
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

/**
 * The context-edit recorder for one actor, or null when nothing records them.
 *
 * NULL in this tree, and stated once here rather than at three call sites.
 * `RunEventRecorder` satisfies the plane's port — no adapter, no cast — the
 * moment the `context_edit` run-event variant exists beside it; until then
 * `null` is the honest answer, because a recorder that cannot represent the
 * event would either drop it silently or throw inside a turn. "Record nothing"
 * is a decision somebody wrote down, which is why the host asks for it instead
 * of defaulting.
 */
function contextEventsFor(_actor: BoundActor): ContextEventRecorder | null {
  return null;
}

/**
 * The run a hosted actor's events belong to: its newest UNSETTLED claim.
 *
 * Read from the durable ledger rather than held in a field, and that is what
 * makes it correct across an eviction: the root's own sink can use an in-memory
 * `_currentRunId` because the root IS the activation, while a hosted actor's
 * events can be produced by an activation that did not admit the turn. A
 * settled actor has no active run, and an event with no run to belong to is
 * DROPPED rather than filed under an empty string — a row keyed on '' is
 * unattributable and would join to every other actor's.
 */
function activeRunOf(stores: BoundActor['stores']): string | null {
  return stores.claims.unsettled(1)[0]?.runId ?? null;
}

/**
 * What a dismissal asks for, as a NAMED type rather than an inline literal.
 *
 * Named because both callers have to add `observed` conditionally — it travels
 * only when the caller actually saw a live claim — and building that with a
 * conditional spread hides the omission behind an empty object. With the type
 * named, each caller assigns the base and adds the member in an `if`, which is
 * the shape that reads as "absent" rather than as "spread of nothing".
 */
export interface ActorRetirementRequest {
  readonly reference: ActorReference;
  readonly name: string;
  readonly keepHistory: boolean;
  observed?: { readonly turnId: string; readonly epoch: number };
}

/** The retirement a dismissal asks for. `destroy` is the INVERSE of
 *  keepHistory: an archive keeps every row and every byte and only stops the
 *  actor; a wipe reclaims both. `observed` travels when the caller actually saw
 *  a live claim, so the host settles it rather than guessing. */
export function actorRetirementFor(input: ActorRetirementRequest): ActorRetirement {
  const retirement: ActorRetirement = {
    reference: input.reference, name: input.name, destroy: !input.keepHistory,
  };

  if (input.observed === undefined) return retirement;

  return { ...retirement, observed: input.observed };
}

/**
 * Interrupted-turn recovery MOVED to core as `recoverActorTurns(host, limit?)`,
 * beside `ActorHost.resumable`.
 *
 * Nothing in it was Cloudflare-shaped — `verifyClaimedProgram`,
 * `readVersionedScaffoldSource`, `sha256Hex`, `host.acquire` and
 * `stores.claims` are all core — and keeping a copy here was a second chance
 * for one of the two backends to be the unreached one, which is exactly what
 * happened: on this backend AND on the CLI at once. One implementation, two
 * callers. This backend's caller is the alarm frame's sweep.
 */
