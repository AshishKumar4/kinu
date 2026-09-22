/**
 * Heads, swarm nodes and MCTS branches as hosted logical actors: a `workspace_actors`
 * row plus stores scoped over the root's one `Storage`; retirement is `host.retire`.
 * Each runs `runHeadInference` as claimed turns on its actor's session, so a promotion
 * landing mid-run cannot take over the turn in flight.
 * `abort` is caller-requested only: no socket close or eviction reaches it; an evicted
 * run leaves an unsettled claim that the root's activation path resumes.
 * Not facets: `do.facet.cpu_shared` means hosted nodes serialise as in one isolate.
 */

import { REAL_CLOCK } from '@kinu.run/core';
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
import { isCFRuntime, type CFRuntime } from './runtime';
import { actorRetirementFor, type ActorRetirementRequest } from './actor-hosting';

/** A swarm node's actor is a head in swarm mode, so only the toolless branch stays apart. */
export interface ExplorationActorRequest {
  readonly creationId: string;
  readonly kind: 'head' | 'branch';
  /** Absent lets `defaultLoopOrigin` stand (`inherit` for both kinds). */
  readonly loop?: LoopOrigin;
}

export interface ExplorationProfile {
  readonly profile: ResolvedTurnProfile;
  readonly inputs: ProfileAuthorityInputs;
}

export interface BranchCompletionRequest {
  readonly actor: HostedActor;
  readonly spec: string;
  /** The route's own reasoning effort; spec and effort are one decision and travel together. */
  readonly effort: ReasoningEffort;
  readonly system?: string;
  readonly user: string;
}

/** Supplied by the root because the provider registry and operation sink are its own. */
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

export interface ExplorationHostSeams {
  readonly host: ActorHost;
  /** Register (or re-find) the actor for this creation id. The root owns the directory. */
  register(input: ExplorationActorRequest): Promise<ActorReference>;
  /**
   * Watch writes the actor makes through its own file view until the disposer runs.
   * Named per run, before the first acquire builds the runtime, and dropped after so a
   * later run cannot inherit the capture (`WorkspaceHostSeams.chosenWriteObserver`).
   */
  watchWrites(reference: ActorReference, writes: WriteObserver): () => void;
  /** The profile authority chats resolve through, so role restrictions narrow heads identically. */
  profile(input: {
    readonly actor: HostedActor;
    readonly availableTools: readonly string[];
    readonly workMode: WorkMode;
  }): Promise<ExplorationProfile>;
  resolveModel(spec: string): LanguageModel;
  webSearch(): WebSearchProvider;
  /** The same provisioner the host uses, so the home a node is told about is the one it has. */
  nodeHome(actor: HostedActor): Promise<NodeWorkspace>;
  /** Typed as `Tool`: core widens `HeadToolDeps.codemodeTool` to `unknown`, this seam need not. */
  codemodeTool(runtime: CFRuntime, webSearch: WebSearchProvider): (finished: ToolSet) => Tool;
  /** The workspace journal, so a depth-2 head's spawn row and step rows join. */
  recordStep(headId: HeadId, seq: number, step: HeadStep): Promise<void>;
  readonly publishDelta: ReportHeadDelta;
  mission(input: HeadInput): MissionScope | null;
  split(actor: HostedActor, runtime: CFRuntime, input: HeadInput): (request: HeadSplitRequest) => Promise<HeadSplitResult>;
}

/** The parent reference the directory recorded; the row is the only authority on it. */
function explorationParent(seams: ExplorationHostSeams, reference: ActorReference): ActorReference {
  const parentId = reference.parentActorId;

  if (parentId === null) throw new KinuError('denied', 'An exploration actor always has a parent.');
  const parent = seams.host.describe(parentId);

  if (parent === null) throw new KinuError('missing', 'The exploration actor has no registered parent.');

  return { actorId: parent.actorId, workspaceId: parent.workspaceId, parentActorId: parent.parentActorId };
}

/** Retire an exploration actor. `observed` travels when a live claim was seen, so the host settles it. */
async function retireExploration(
  seams: ExplorationHostSeams, reference: ActorReference, name: string,
): Promise<void> {
  const live = seams.host.hosted(reference);
  const claim = live === null ? null : live.session.turnClaim;
  const request: ActorRetirementRequest = { reference, name, keepHistory: false };

  if (claim !== null) request.observed = { turnId: claim.turnId, epoch: claim.epoch };
  const retirement = actorRetirementFor(request);
  await seams.host.retire(explorationParent(seams, reference), retirement);
}

/** The caller's pinned spec wins (heterogeneous heads); else the route's, resolved through the
 *  profile, since the account default would ignore the role's tier. */
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

/** `memoryTail` absent and `missingCapabilities` empty by fact: heads don't read MEMORY.md and connect no MCP servers. */
function explorationDynamicContext(actor: HostedActor, profile: ResolvedTurnProfile, tools: ToolSet): DynamicContext {
  return collectDynamicContext({
    rt: actor.runtime,
    stores: actor.stores,
    profile,
    tools,
    memoryTail: undefined,
    missingCapabilities: [],
    subordinateDelegates: () => subordinateDelegatesOf([]),
  });
}

/** A branching head, hosted. The actor is retired when `run()` settles. */
export async function hostHead(seams: ExplorationHostSeams, input: HeadInput): Promise<SpawnedHead> {
  const reference = await seams.register({ creationId: input.id, kind: 'head', loop: input.loop });
  const name = explorationActorKey(input.id);
  /** The caller's explicit stop; a socket close or evicted isolate must leave this false. */
  let stopped: string | null = null;

  return {
    id: input.id,
    run: async (): Promise<HeadReport> => {
      // Created before `host.run` because acquiring builds the runtime over the watched
      // file view; a later capture would report no file changes.
      const capture = new HeadCapture();
      const unwatch = seams.watchWrites(reference, capture.files);

      try {
        return await seams.host.run(reference, async (actor) => {
          // `runtimeFor` returns `AgentRuntime` unnarrowed; on this backend it is `createCFRuntime`.
          const runtime = actor.runtime;

          if (!isCFRuntime(runtime)) {
            throw new KinuError('unsupported', 'a hosted head must run on the cf runtime');
          }

          const webSearch = seams.webSearch();
          const spec = await explorationModelSpec(seams, actor, 'head', input.model);

          const deps: HeadInferenceDeps = {
            actor,
            runId: crypto.randomUUID(),
            clock: REAL_CLOCK,
            model: seams.resolveModel(spec),
            tools: buildHeadToolSet({
              input, capture, rt: runtime, history: actor.stores.history,
              codemodeTool: seams.codemodeTool(runtime, webSearch),
              webSearch,
              split: seams.split(actor, runtime, input),
            }),
            capture,
            workspaceLayout: 'shared-workspace',
            isAborted: () => stopped !== null,
            abortReason: () => stopped,
            profile: (request) => seams.profile({ actor, ...request }),
            dynamic: (profile, tools) => explorationDynamicContext(actor, profile, tools),
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
    /** Explicit stop: records the reason and interrupts the live turn. Not reachable from a transport close. */
    abort: async (reason: string): Promise<void> => {
      stopped = reason;
      seams.host.hosted(reference)?.session.interrupt();
    },
  };
}

/**
 * A factory, not a value: `swarm-expansion.ts` shallow-copies node deps per child, so a
 * single `actor` would give every node one claim ledger and row set.
 */
export async function hostNodeSeat(
  seams: ExplorationHostSeams, node: NodeIdentity,
): Promise<HostedNodeSeat> {
  // Kind fold retired `node`: a seat is a head row; stored `node` rows load via the directory's read translation.
  const reference = await seams.register({ creationId: node.nodeId, kind: 'head' });
  const actor = await seams.host.acquire(reference);

  return {
    actor,
    runId: crypto.randomUUID(),
    profile: (request) => seams.profile({ actor, ...request }),
    dynamic: (profile, tools) => explorationDynamicContext(actor, profile, tools),
  };
}

/**
 * Retire exploration actors whose work is provably finished. The ledger is the only
 * status authority: any reported status is terminal, unknown statuses are not, and
 * an unledgered actor is retired only when nothing live claims exploration work,
 * because a search creates its actor before its node row.
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

/** Only the actor name carries the `exp:` marker, so a generated id never collides with a roster slug. */
function parseExplorationId(storageKey: string, name: string): string {
  const marked = name.startsWith('exp:') ? name.slice(4) : name;

  return marked === '' ? storageKey : marked;
}

/**
 * An MCTS rollout branch: no ToolSet, no plane, no home. The durable trace is
 * `search_nodes.observation`. The engine releases it in the `finally` after every reflection.
 */
export async function hostBranch(
  seams: ExplorationHostSeams,
  branchId: string,
  deps: BranchRunnerDeps,
): Promise<BranchHandle> {
  const reference = await seams.register({ creationId: branchId, kind: 'branch' });
  const name = explorationActorKey(branchId);
  /** Held in memory for the reflection that may follow; the handle's life is the window. */
  let trace = '';

  return {
    explore: (request) => seams.host.run(reference, async (actor) => {
      const { priorHistory, craftedTools, languages, mode, siblings } = request;
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
 * Stop one branch by id; ends at `retireExploration` like `release()`. `register` re-finds
 * (idempotent on the creation id). Wired beside `spawn` and never without it.
 */
export async function abortHostedBranch(
  seams: ExplorationHostSeams, branchId: string,
): Promise<void> {
  const reference = await seams.register({ creationId: branchId, kind: 'branch' });
  await retireExploration(seams, reference, explorationActorKey(branchId));
}
