/**
 * Heads, swarm nodes and MCTS branches as HOSTED LOGICAL ACTORS.
 *
 * This is what `facet-spawn.ts` was, minus the reason it existed. That module's
 * whole subject was a facet's private SQLite: a bootstrap sequence that had to
 * be acknowledged before a handle was safe to return (because the facet had to
 * persist what it was about to run), a `discardHalfSeededFacet` path for a
 * bootstrap that failed, two non-interchangeable teardown verbs (`abort` keeps
 * the database, `delete` wipes it), a `runOnceAndReclaim` wrapper that reported
 * a leaked database louder than a failed run, and a reconciliation sweep over
 * `listSubAgents()` to reclaim databases a reset left behind. Every one of those
 * is gone with the database: an exploration actor is a row in
 * `workspace_actors` plus stores scoped over the root's one `Storage`, so there
 * is nothing to seed across an RPC, nothing to acknowledge, nothing to leak and
 * nothing to sweep. Retirement is one call — `host.retire` — and the two verbs
 * collapse into its `destroy` flag.
 *
 * WHAT REPLACED THE ISOLATE BOUNDARY, and what did not. The facet never bought
 * parallelism: `do.facet.cpu_shared` means a wave of hosted nodes serialised
 * exactly as one isolate's `Promise.allSettled` did, and this tree said so where
 * the node host used to live. What it bought was containment, and containment
 * now rides the ACTOR: a head's tools are built over the head actor's own
 * runtime, its writes land under its own uid on both planes, and its rows are
 * scoped to its own `actor_id`. What it also bought, accidentally, was a set of
 * cross-DO round trips per step — a step sink, a delta sink, a mission guard, a
 * profile fetch and an arbiter verdict, all RPCs into the root — and those are
 * now plain calls on objects in the same isolate. The arbiter in particular
 * stops being a registry keyed by node id: a host runs in the search's isolate,
 * so it simply holds the closure.
 *
 * ONE INFERENCE LOOP. A head, a node and a recursive sub-head all run
 * `runHeadInference` over a `HostedActor`, so each iteration is a CLAIMED turn
 * on that actor's session: `beginTurn` → `bindProfile` → execute →
 * `settleTurnClaim` → `finishTurn`. That is where the promoted-loop contract
 * comes from — a head runs its actor's pinned program version and digest, gets
 * the per-step context plane and the cancellation an actor chat already had, and
 * a promotion that lands mid-run cannot take over the turn in flight.
 *
 * CANCELLATION IS EXPLICIT, ALWAYS. `abort` here is a caller-requested stop — a
 * deadline blew, a search was cancelled, an owner pressed cancel. No websocket
 * close, no request abort and no eviction reaches it: an evicted run leaves an
 * unsettled claim, which is the record that work is owed, and the root's normal
 * activation path resumes from it.
 */

import type { LanguageModel, Tool, ToolSet } from 'ai';
import {
  HeadCapture, buildHeadToolSet, runHeadInference,
  collectDynamicContext, explorationActorKey, headStatusUnsettled, resolveModelRoute,
  storedHeadReportStatus, subordinateDelegatesOf,
  type ActorHost, type ActorReference, type BranchExploration, type BranchHandle,
  type BranchReflection, type CraftedTool, type HeadId, type HeadInferenceDeps,
  type HeadInput, type HeadReport, type HeadSplitRequest, type HeadSplitResult,
  type DynamicContext, type HeadStep, type HostedActor, type HostedNodeSeat,
  type LoopOrigin, type MissionScope, type NodeIdentity, type NodeWorkspace,
  type ProfileAuthorityInputs, type ReasoningEffort, type ReportHeadDelta,
  type ResolvedTurnProfile,
  type SpawnedHead, type WebSearchProvider, type WorkMode, type WriteObserver,
} from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import type { CFRuntime } from './runtime';
import { actorRetirementFor, type ActorRetirementRequest } from './actor-hosting';

/** One creation an exploration runner asks the root to register. A swarm node's
 *  actor is a head running in swarm mode, so `head` covers both runners and
 *  only the toolless branch stays apart. */
export interface ExplorationActorRequest {
  readonly creationId: string;
  readonly kind: 'head' | 'branch';
  /** What this child should think with. Absent lets `defaultLoopOrigin` stand,
   *  which for both kinds is `inherit` — a fork of an actor's reasoning
   *  that ran a fresh v0 would be a fork of nothing the actor had learned. */
  readonly loop?: LoopOrigin;
}

/** The profile a hosted exploration turn resolves under, with the authority
 *  inputs the claim records beside it. */
export interface ExplorationProfile {
  readonly profile: ResolvedTurnProfile;
  readonly inputs: ProfileAuthorityInputs;
}

/** One bare model call, as a branch makes it: no tools, no runtime, one answer
 *  and its usage. Named here because the branch handle's whole surface is two
 *  of these and the caller supplies the transport. */
export interface BranchCompletionRequest {
  readonly actor: HostedActor;
  readonly spec: string;
  /**
   * The ROUTE's own reasoning effort, carried rather than re-derived.
   *
   * `resolveModelRoute('mcts', …)` computes this beside the spec, so a
   * transport that took the spec and then reached for a constant would compute
   * the route's effort and throw it away — which is the exact substitution the
   * routing table exists to refuse. The spec and the effort are ONE decision
   * and they travel together.
   */
  readonly effort: ReasoningEffort;
  readonly system?: string;
  readonly user: string;
}

/** The prompts and the model call a hosted branch runs. Supplied by the root
 *  because the provider registry and the operation sink are its own. */
export interface BranchRunnerDeps {
  explorePrompt(input: {
    readonly mode: WorkMode;
    readonly context: string;
    readonly craftedTools: CraftedTool[];
    readonly languages: readonly [string, ...string[]];
    readonly siblings: readonly string[];
  }): { readonly system: string; readonly user: string };
  reflectionPrompt(task: string, traces: string, outcome?: string): string;
  complete(request: BranchCompletionRequest): Promise<BranchExploration>;
}

/** What every exploration runner needs of the workspace that owns it. One
 *  interface for all three kinds because all three want exactly this: the host
 *  to acquire an actor from, the directory operation that registers one, the
 *  model and profile authority, and where a step and a frame go. */
export interface ExplorationHostSeams {
  readonly host: ActorHost;
  /** Register (or re-find) the exploration actor for this creation id. The root
   *  owns the directory; a runner never writes it. */
  register(input: ExplorationActorRequest): Promise<ActorReference>;
  /**
   * Watch every write and delete the actor for `reference` makes through its
   * OWN workspace file view, until the returned disposer runs.
   *
   * A RUN names this, not a creation, and that is why it is not one more field
   * on {@link ExplorationActorRequest} beside `loop`: registration happens once
   * when the head is spawned, while the capture whose observer this is belongs
   * to the run that produces the report. The host builds the actor's runtime at
   * first acquire, so the watcher has to be named BEFORE it and forgotten after
   * — a later run under the same reference must not inherit the previous one's
   * capture, and `HeadFileChanges` accumulates for exactly as long as it is
   * reachable.
   *
   * The register itself is the root's, for the reason `loop` is
   * (`WorkspaceHostSeams.chosenWriteObserver`): `ActorHostDeps.runtimeFor`
   * takes the binding and nothing a caller invented, so a caller-known fact the
   * runtime needs travels as a slot the host reads and never as a wider seam.
   */
  watchWrites(reference: ActorReference, writes: WriteObserver): () => void;
  /** THE profile authority — the same one an actor chat resolves through, so a
   *  role restriction narrows a head exactly as it narrows a conversation. */
  profile(input: {
    readonly actor: HostedActor;
    readonly availableTools: readonly string[];
    readonly workMode: WorkMode;
  }): Promise<ExplorationProfile>;
  /** Bind a model spec to a client through the owner's provider registry. */
  resolveModel(spec: string): LanguageModel;
  webSearch(): WebSearchProvider;
  /**
   * The private home this workspace provisions for ONE bound exploration
   * actor, as the node-boundary vocabulary reports it.
   *
   * The host already provisions this to build the actor's runtime; this is that
   * same provisioner, not a second one, so the home a node is TOLD it has is
   * the home its shell and file tools are actually credentialed for. Without it
   * the swarm's `provisionNodeHome` seam is absent and every node on this
   * backend reports `shared-origin-plane` — told to treat the tree as
   * read-mostly while owning a private directory nobody mentioned.
   */
  nodeHome(actor: HostedActor): Promise<NodeWorkspace>;
  /** The `execute_tools` surface an exploration actor gets over its own runtime.
   *  A `Tool`, named: core's `HeadToolDeps.executeTool` widens it to `unknown`
   *  because the shape is the AI SDK's and core does not depend on it, but this
   *  seam is both ends' own backend and has no reason to hand its caller a
   *  value it cannot use. */
  executeTool(runtime: CFRuntime, webSearch: WebSearchProvider): (finished: ToolSet) => Tool;
  /** Where a finished step lands while the actor still runs: the journal that
   *  holds this head's own row, which is the workspace's — ONE database now, so
   *  a depth-2 head's spawn row and its step rows finally join. */
  recordStep(headId: HeadId, seq: number, step: HeadStep): Promise<void>;
  /** Transient frames, painted while a step is still being produced. */
  readonly publishDelta: ReportHeadDelta;
  /** The mission ledger this run charges, or null when it charges none. */
  mission(input: HeadInput): MissionScope | null;
  /** A recursive split, over the head actor that is splitting. */
  split(actor: HostedActor, runtime: CFRuntime, input: HeadInput): (request: HeadSplitRequest) => Promise<HeadSplitResult>;
}

/** The actor that owns this creation — the parent reference the directory
 *  recorded. A retirement is always asked FOR a child BY its parent, and the
 *  row is the only authority on which parent that is. */
function explorationParent(seams: ExplorationHostSeams, reference: ActorReference): ActorReference {
  const parentId = reference.parentActorId;

  if (parentId === null) throw new KinuError('denied', 'An exploration actor always has a parent.');
  const parent = seams.host.describe(parentId);

  if (parent === null) throw new KinuError('missing', 'The exploration actor has no registered parent.');

  return { actorId: parent.actorId, workspaceId: parent.workspaceId, parentActorId: parent.parentActorId };
}

/**
 * Retire an exploration actor: its run is over and nothing will read it again,
 * so its rows and its bytes both go.
 *
 * `observed` travels when the actor still held a live claim, which is what a
 * cut-short run leaves behind — the host settles that claim rather than
 * guessing at how a turn nobody named an outcome for ended.
 */
async function retireExploration(
  seams: ExplorationHostSeams, reference: ActorReference, name: string,
): Promise<void> {
  const live = seams.host.hosted(reference);
  const claim = live === null ? null : live.session.turnClaim;
  // `observed` only when a live claim was actually seen — absent is what lets
  // the host settle rather than guess, and a spread of nothing does not say so.
  const request: ActorRetirementRequest = { reference, name, keepHistory: false };

  if (claim !== null) request.observed = { turnId: claim.turnId, epoch: claim.epoch };
  const retirement = actorRetirementFor(request);
  await seams.host.retire(explorationParent(seams, reference), retirement);
}

/** The spec a head or a node runs its model under: the one its caller PINNED,
 *  or the route's when the caller pinned none. The pin wins deliberately —
 *  heterogeneous heads are a real feature — and the fallback resolves through
 *  the profile, because asking the registry for the account default serves a
 *  role running on any tier but the default with a model it did not select. */
async function explorationModelSpec(
  seams: ExplorationHostSeams,
  actor: HostedActor,
  source: 'head' | 'swarm',
  pinned: string | null | undefined,
): Promise<string> {
  if (pinned) return pinned;
  const { profile } = await seams.profile({ actor, availableTools: [], workMode: 'build' });
  const route = resolveModelRoute(source, profile);

  if (!route) throw new KinuError('denied', `a hosted ${source} run cannot use the fixed platform model route`);

  return route.model;
}

/**
 * The live plane a hosted exploration turn reports in its per-step block: its
 * own hires and the search roster its journal contributes.
 *
 * `memoryTail` is deliberately absent and `missingCapabilities` deliberately
 * empty, and both are facts rather than gaps. A head's framing is built from
 * its `HeadInput` — `MEMORY.md` is not part of what a fork was split off to
 * read — and a hosted exploration actor connects no MCP servers, so there is no
 * unreachable server to name. Passing a stub value for either would put a claim
 * nobody measured into the model's context.
 */
function explorationDynamicContext(actor: HostedActor): DynamicContext {
  return collectDynamicContext({
    rt: actor.runtime,
    stores: actor.stores,
    memoryTail: undefined,
    missingCapabilities: [],
    subordinateDelegates: () => subordinateDelegatesOf([]),
  });
}

/**
 * A BRANCHING HEAD, hosted.
 *
 * `run()` settling IS the terminal point, exactly as it was for the facet: the
 * `HeadReport` carries the summary, evidence, decisions, artifacts, file
 * changes, tool calls and step count, and every journal row for what this head
 * split into lives on the workspace. So the actor is retired when the run
 * settles — and unlike the facet version there is no "leaked into the root's
 * quota" branch to report, because a hosted actor that is not retired is a
 * roster row and not a database.
 */
export async function hostHead(seams: ExplorationHostSeams, input: HeadInput): Promise<SpawnedHead> {
  const reference = await seams.register({ creationId: input.id, kind: 'head', loop: input.loop });
  const name = explorationActorKey(input.id);
  /** The caller's explicit stop. NOT derived from any transport: a socket close
   *  or an evicted isolate must leave this false, so an interrupted run is
   *  resumable rather than reported as cancelled. */
  let stopped: string | null = null;

  return {
    id: input.id,
    run: async (): Promise<HeadReport> => {
      // THE RUN'S OWN CAPTURE, and it is created OUT HERE rather than inside
      // the work below because of the order the host works in: `host.run`
      // acquires the actor, and acquiring it is what BUILDS its runtime over
      // the file view this head's writes land on. `HeadReport.fileChanges` is
      // `capture.files.snapshot()` and nothing else fills it, so a capture
      // created after the acquire watches a plane that was already composed and
      // the report says the head changed nothing however much it wrote. The
      // watcher is dropped when the run ends, so the next run under this
      // reference cannot inherit this run's changes.
      const capture = new HeadCapture();
      const unwatch = seams.watchWrites(reference, capture.files);

      try {
        return await seams.host.run(reference, async (actor) => {
          // SAFETY: this runtime is the one `ActorHostDeps.runtimeFor` built,
          // which on this backend IS `createCFRuntime`. The core seam declares
          // its RETURN type as `AgentRuntime` and does not narrow the value, so
          // the cf members a head's surface reaches are present by construction.
          const runtime = actor.runtime as CFRuntime;
          const webSearch = seams.webSearch();
          const spec = await explorationModelSpec(seams, actor, 'head', input.model);

          const deps: HeadInferenceDeps = {
            actor,
            runId: crypto.randomUUID(),
            model: seams.resolveModel(spec),
            tools: buildHeadToolSet({
              input, capture, rt: runtime,
              executeTool: seams.executeTool(runtime, webSearch),
              webSearch,
              split: seams.split(actor, runtime, input),
            }),
            capture,
            workspaceLayout: 'shared-workspace',
            isAborted: () => stopped !== null,
            abortReason: () => stopped,
            profile: (request) => seams.profile({ actor, ...request }),
            dynamic: () => explorationDynamicContext(actor),
            reportStep: (seq, step) => seams.recordStep(input.id, seq, step),
            reportDelta: seams.publishDelta,
          };

          const mission = seams.mission(input);

          if (mission !== null) deps.mission = mission;

          return await runHeadInference(input, deps);
        });
      } finally {
        unwatch();
        await retireExploration(seams, reference, name);
      }
    },
    /**
     * Cut this head short — a caller-requested deadline blew, or the search was
     * cancelled. An EXPLICIT stop and the only one: it records the reason the
     * report will carry and interrupts the actor's live turn, which aborts the
     * step in flight instead of waiting for a boundary, leaving `run()` to
     * settle and retire. Nothing here is reachable from a transport close.
     */
    abort: async (reason: string): Promise<void> => {
      stopped = reason;
      seams.host.hosted(reference)?.session.interrupt();
    },
  };
}

/**
 * ONE SWARM NODE'S SEAT, hosted.
 *
 * A FACTORY and not a value, and that is the whole reason this member exists:
 * `buildNodeDeps` builds the node deps ONCE per search and shallow-copies them
 * per child (`swarm-expansion.ts` spreads `{ ...nodeDeps, model }`), so a
 * single `actor` on those deps would hand every node of a wave one claim
 * ledger, one loop pointer and one row set — precisely the cross-actor
 * collision this cutover exists to make impossible. Asked per node, it answers
 * with that node's own actor, its own run id, and the profile and live-context
 * seams bound to it.
 *
 * There is no `NodeLoopHost` on this backend any more. That seam existed to
 * carry a spec across a Durable Object boundary and to publish an arbiter under
 * the node's id so a facet could reach the search's budget by RPC. Both are
 * gone: the loop runs in the search's own isolate over the node actor's
 * runtime, and the arbiter is passed to it as the closure it always was.
 */
export async function hostNodeSeat(
  seams: ExplorationHostSeams, node: NodeIdentity,
): Promise<HostedNodeSeat> {
  // A swarm node's seat is a HEAD row: the kind fold retired `node`, and the
  // swarm mode travels with the seat (its run id, its journal) rather than the
  // row. Stored `node` rows still load through the directory's read translation.
  const reference = await seams.register({ creationId: node.nodeId, kind: 'head' });
  const actor = await seams.host.acquire(reference);

  return {
    actor,
    runId: crypto.randomUUID(),
    profile: (request) => seams.profile({ actor, ...request }),
    dynamic: () => explorationDynamicContext(actor),
  };
}

/**
 * Retire exploration actors whose work is provably finished.
 *
 * The descendant of `reconcileExplorationFacets`, and it is a much smaller
 * claim than that function had to make. The old sweep existed because an
 * unreclaimed facet was a PERMANENT DATABASE inside the root, charged against a
 * quota whose overflow is a reset rather than a catchable error — so it read
 * `listSubAgents()`, matched every facet against a ledger, and destroyed
 * storage on the strength of that match. What is left behind now is a
 * `workspace_actors` row and an `actor_id`-scoped set of rows in the one
 * database, so the sweep is bookkeeping: it retires rows nothing will read
 * again and costs nothing when it is late.
 *
 * The ledger is still the ONLY status authority — there is no per-actor copy. A
 * head that REPORTED is finished whatever it reported: `errored` and
 * `budget_exceeded` are terminal exactly as `completed` and `aborted` are. A
 * status the journal does not write reads UNKNOWN rather than either, and an
 * unledgered actor is retired only when nothing live claims exploration work,
 * because a search creates its actor BEFORE it writes the node row.
 */
export async function reclaimSettledExplorationActors(
  seams: ExplorationHostSeams,
  ledger: {
    readHead(id: string): { readonly status: string } | null;
    hasLiveExploration(): boolean;
  },
): Promise<{ readonly retired: number; readonly retained: number }> {
  let retired = 0;
  let retained = 0;
  const live = ledger.hasLiveExploration();

  for (const reference of seams.host.list()) {
    const record = seams.host.describe(reference.actorId);

    if (record === null || record.kind === 'main' || record.kind === 'subordinate') {
      retained += 1;
      continue;
    }

    const head = ledger.readHead(parseExplorationId(record.storageKey, record.name));

    const settled = head === null
      ? !live
      : !headStatusUnsettled(head.status) && storedHeadReportStatus(head.status) !== null;

    if (!settled) {
      retained += 1;
      continue;
    }

    await retireExploration(seams, reference, record.name);
    retired += 1;
  }

  return { retired, retained };
}

/** The domain id inside an exploration actor's key. Journals and handles carry
 *  the plain id; only the actor NAME carries the `exp:` marker that keeps a
 *  generated id from ever colliding with a roster slug. */
function parseExplorationId(storageKey: string, name: string): string {
  const marked = name.startsWith('exp:') ? name.slice(4) : name;

  return marked === '' ? storageKey : marked;
}

/**
 * An MCTS ROLLOUT BRANCH, hosted.
 *
 * A branch reasons; it does not act. No ToolSet, no execution plane, no home —
 * containment used to ride the facet's DO identity and now rides the actor: it
 * is a `'branch'` row with `actor_id`-scoped storage and nothing mounted.
 *
 * THE TRACE. The facet kept a private `traces` table for one reason: `explore`
 * and `generateReflection` were two RPCs into an object that could hibernate
 * between them, so the text had to be durable somewhere the second call could
 * read. In one isolate the handle holds it — and the durable copy already exists
 * anyway, as `search_nodes.observation`, which the engine writes for the node
 * this branch produced and reads back when it scores. So there is no branch
 * trace store, in core or here.
 *
 * RELEASED BY THE CALLER, not here: the engine owns a branch for exactly one
 * iteration — it explores, gets scored, and may be asked to reflect on why it
 * scored badly — and closes that window in the `finally` that releases every id
 * it spawned, strictly after every reflection.
 */
export async function hostBranch(
  seams: ExplorationHostSeams,
  branchId: string,
  deps: BranchRunnerDeps,
): Promise<BranchHandle> {
  const reference = await seams.register({ creationId: branchId, kind: 'branch' });
  const name = explorationActorKey(branchId);
  /** The one thing this branch produced, held for the reflection that may
   *  follow it. In memory because the handle's life IS the window: the engine
   *  releases it after the last reflection of the iteration. */
  let trace = '';

  return {
    explore: (priorHistory, craftedTools, languages, mode, siblings) => seams.host.run(reference, async (actor) => {
      const { profile } = await seams.profile({ actor, availableTools: [], workMode: mode });
      const route = resolveModelRoute('mcts', profile);

      if (!route) throw new KinuError('denied', 'an MCTS branch cannot use the fixed platform model route');

      const { system, user } = deps.explorePrompt({
        mode,
        context: priorHistory.map((turn) => `${turn.role}: ${turn.content}`).join('\n\n'),
        craftedTools, languages, siblings: siblings ?? [],
      });

      const answer = await deps.complete({
        actor, spec: route.model, effort: route.reasoningEffort, system, user,
      });

      trace = answer.text;

      return answer;
    }),
    generateReflection: (task, outcome) => seams.host.run(reference, async (actor): Promise<BranchReflection> => {
      const { profile } = await seams.profile({ actor, availableTools: [], workMode: 'build' });
      const route = resolveModelRoute('mcts', profile);

      if (!route) throw new KinuError('denied', 'an MCTS reflection cannot use the fixed platform model route');

      const answer = await deps.complete({
        actor, spec: route.model, effort: route.reasoningEffort,
        user: deps.reflectionPrompt(task, trace, outcome),
      });

      return { text: answer.text, usage: answer.usage };
    }),
    release: () => retireExploration(seams, reference, name),
  };
}

/**
 * Stop one branch by id — the abort half of `AgentRuntime.abortBranch`.
 *
 * A branch's own handle carries `release()`, which is what the engine calls in
 * the `finally` of a normal iteration. This is the other path: the engine
 * cancelling a rollout it can no longer finish, holding only the id. Both end
 * at the same `retireExploration`, so an aborted branch and a released one
 * leave the directory in one state rather than two.
 *
 * `register` RE-FINDS here rather than creating: it is idempotent on the
 * creation id, and abort is only ever called for an id this engine spawned. It
 * is spelled this way because the seam exposes the host and the registrar and
 * not the directory, so re-finding through the registrar is how a caller
 * holding an id reaches the reference the retirement needs.
 *
 * WIRED BESIDE `spawn` AND NEVER WITHOUT IT: a search that can start rollouts
 * and cannot stop them is worse than one that refuses, which is the same
 * argument `requireBranches` makes in the other direction.
 */
export async function abortHostedBranch(
  seams: ExplorationHostSeams, branchId: string,
): Promise<void> {
  const reference = await seams.register({ creationId: branchId, kind: 'branch' });
  await retireExploration(seams, reference, explorationActorKey(branchId));
}
