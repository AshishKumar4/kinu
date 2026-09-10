// createCLIHeadRuntime — the local HeadRuntime backing the `agents` tool's fork
// action. The cf backend runs heads as SubordinateAgent facets in head mode; locally each
// head runs IN-PROCESS as a LOGICAL ACTOR of the workspace it forks
// (buildCLIHeadRuntime): the parent's real host executor (`run laptop` /
// codemode `laptop.*`), the parent's canonical workspace through `parent.*`,
// and its own home in the one file plane so siblings can't corrupt each other.
// Heads are LLM-bound, so the HeadController's Promise.all gives real
// concurrency without subprocesses; the merge LLM runs in this process.
//
// ONE DATABASE. A head opens no per-head scratch file under `~/.kinu/heads/`: it is acquired
// from the root's ActorHost, so its claims, journal steps, scaffold pointer and
// program state are its own actor-keyed rows in the workspace's one store —
// which is what lets a head take a CLAIMED turn (the promoted-loop contract)
// instead of an unclaimed loop over private bytes nobody else could read.
//
// The tool surface is the SAME backend-agnostic buildHeadToolSet the cf Facet
// uses: `run` + `execute_tools` + `web` (the parent's vocabulary, so a fork's
// allowedTools maps onto real tools) + record_evidence/record_decision +
// split_subheads (recursive nested HeadController, depth-budgeted).

import type { LanguageModel, ToolSet } from 'ai';
import {
  type HeadRuntime, type HeadGrounding, type SpawnedHead, type HeadInput, type HeadReport,
  type WebSearchProvider, type CodemodeProvider,
  type HeadSplitRequest, type HeadSplitResult,
  type HeadMergeModelBinder, type ResolvedTurnProfile,
  type MissionGovernor, type ModelCallSink, type ModelOperationSink,
  type DynamicContext, type HostedActor, type ProfileAuthorityInputs, type WorkMode, type WriteObserver,
  HeadCapture, runHeadInference, buildHeadToolSet, HeadController, type HeadJournal,
  createDbCodemodeProvider, createStateCodemodeProvider,
  headMergeLLM,
  localMissionScope,
} from '@kinu.run/core';
import { diagnostics, toKinuError, renderThrownChain } from '@kinu.run/core/obs';
import type { CLIRuntime } from './runtime';
import { createNodeExecuteToolFactory } from './execute-tools-factory';

/**
 * One head's seat: the runtime objects its CLAIMED loop runs on.
 *
 * The four members `runHeadInference` needs beyond its tools — the session a
 * turn is admitted on, the run its claims attribute to, the profile authority
 * that pins its program version, and the live context block for its own actor
 * — plus the release that ends the seat. The local twin of core's
 * `HostedNodeSeat`, because a head and a swarm node are the same kind of thing
 * on this backend: a hosted actor running one promoted loop.
 */
export interface HostedHeadSeat {
  readonly actor: HostedActor;
  readonly runId: string;
  readonly profile: (input: { readonly availableTools: readonly string[]; readonly workMode: WorkMode })
  => Promise<{ readonly profile: ResolvedTurnProfile; readonly inputs: ProfileAuthorityInputs }>;
  readonly dynamic: () => DynamicContext;
  /** Drop this head's runtime objects and retire its directory row. */
  release: () => Promise<void>;
}

export interface CLIHeadRuntimeDeps {
  /** The session's model for a head that names none or cannot resolve theirs —
   *  read PER SPAWN, not at construction: a resolver session claims its model
   *  on first turn, so the session model may simply not exist yet when the
   *  runtime is built. */
  model: () => LanguageModel;
  /** The profile the merge's `judge` route resolves against — the same seam the
   *  Cloudflare backend hands `createHeadRuntime`. A thunk, read per merge. */
  profile: () => Promise<ResolvedTurnProfile>;
  /** How this session turns that routed (spec, effort) pair into a client. The
   *  only merge decision left locally; core owns the rest. */
  bindMergeModel: HeadMergeModelBinder;
  /** Resolve a per-search model spec (`HeadInput.model`) to a model. Without it
   *  every head runs `model` above, which made the per-search `model` field —
   *  advertised on the `agents` swarm schema and honoured by the cf backend —
   *  a silent no-op here: a panel asked for three vendors got three copies of
   *  one. Absent (no resolver on the session) the fallback is still `model`,
   *  and so is an unresolvable spec, because a fork that cannot honour its
   *  model should still run rather than fail the whole split. */
  resolveModel?: (spec: string) => LanguageModel;
  /** The parent session's runtime — the real execution surface every head forks
   *  (host executor, files, llm/executor/schedule, checkpoints). */
  parentRuntime: CLIRuntime;
  /** The shared web research provider — same seam the main loop uses. Backs the
   *  head's `web` tool. */
  webSearch: WebSearchProvider;
  /** Extra codemode namespaces spliced into the head's execute_tools sandbox —
   *  `web.*`, WITHOUT `agents.*`/`agent.*`: a head forks its
   *  parent's resources, never its authority to delegate. */
  codemodeExtras: () => CodemodeProvider[];
  /** Execution-grounding seam — the same executor + judge the MCTS engine uses,
   *  so head outcomes + the merge are grounded, not heuristic. Omit ⇒ neutral
   *  scores + n=1 merge. */
  grounding?: HeadGrounding;
  /** The session's mission governor. A local head runs in the same process as
   *  the ledger, so its port is the governor itself — the cf backend's has to
   *  cross a facet boundary to reach the same thing. Consulted only for a head
   *  that carries labels, so an unbudgeted run never reads the table. Read per
   *  head, because the runtime is built before the governor exists. */
  governor: () => MissionGovernor;
  /** The session's head journal — where a head's finished steps land as they
   *  happen. A local head runs in the same process as the journal, so this is a
   *  direct write where the cf backend has to cross a facet boundary for it.
   *  Read per head, for the same reason the governor is. */
  journal: () => HeadJournal;
  /** Where the MERGE synthesis reports what it cost.
   *
   *  Only the merge. A head's OWN inference is aggregated from `head_journal`
   *  instead, and two writers for one call is how a total learns to
   *  double-count. The merge is neither of those: `summarizeCost` (core
   *  heads/controller.ts:611-624) folds only the HEADS' reports, so this call —
   *  made by the parent, in the parent's process — is counted nowhere else.
   *  REQUIRED for exactly that reason: core's policy takes a sink rather than an
   *  optional one, because an unreported merge is spend no total ever sees. */
  reportModelCall: ModelCallSink;
  /** Where the merge call's operation lifecycle — its start/end rows — is
   *  filed. Rides beside `reportModelCall` for the same reason core's
   *  `generateJson` keeps them on one `spend`: two facts about ONE call, and
   *  a caller that wired them separately could report a cost for an operation
   *  it never opened. Omit ⇒ the merge runs unwatched, like any seam with no
   *  sink. */
  operations?: ModelOperationSink;
  /**
   * Seat ONE head as a logical actor of this workspace, watched by `writes`.
   *
   * A FACTORY, not a value, for the reason core's `HostedNodeSeat` is one: a
   * split runs several heads concurrently off one deps object, and a single
   * hosted actor shared between them would give the whole wave one claim
   * ledger, one loop pointer and one row set — the cross-actor collision this
   * makes impossible. Each call registers its own actor, acquires its runtime
   * objects from the root's host under the origin this `HeadInput` names, and
   * hands back the release that retires it.
   *
   * `writes` is the run's own `HeadCapture.files`, and it is a PARAMETER rather
   * than something the seater could know: the head's file attribution is per
   * RUN, the capture is created by the run, and the runtime it must wrap is
   * built inside `acquire`. A seat built without it reports an empty
   * `fileChanges` for a head that rewrote the tree.
   */
  hostHead: (input: HeadInput, writes: WriteObserver) => Promise<HostedHeadSeat>;
}

export function createCLIHeadRuntime(deps: CLIHeadRuntimeDeps): HeadRuntime {
  const runtime: HeadRuntime = {
    async spawnHead(input: HeadInput): Promise<SpawnedHead> {
      const abort = new AbortController();
      return {
        id: input.id,
        run: () => runLocalHead(input, deps, abort.signal),
        async abort(reason: string) { abort.abort(new Error(reason)); },
      };
    },
    mergeLLM: headMergeLLM({
      profile: deps.profile,
      bindMergeModel: deps.bindMergeModel,
      reportModelCall: deps.reportModelCall,
      operations: deps.operations,
    }),
  };
  return deps.grounding ? { ...runtime, grounding: deps.grounding } : runtime;
}

/** The model THIS head runs — its own spec when it named one and the session can
 *  resolve it, else the session's. A bad spec degrades to the session model
 *  rather than failing the head: one fork's unresolvable model must not take
 *  down a split the other forks are already running. */
function headModel(input: HeadInput, deps: CLIHeadRuntimeDeps): LanguageModel {
  if (!input.model || !deps.resolveModel) return deps.model();
  try {
    return deps.resolveModel(input.model);
  } catch (err) {
    diagnostics.failure(
      'head.model_resolve_failed',
      toKinuError({
        doing: "resolving the model this head named — running the session's model instead",
        cause: err,
        otherwise: 'bad_input',
      }),
      { headId: input.id, model: input.model },
    );
    return deps.model();
  }
}

/**
 * Run one head in-process, as a hosted logical actor of the parent workspace.
 *
 * The head takes a SEAT: the root's host builds its runtime, stores,
 * orchestration and the one `ActorSession` its claimed turns are admitted on,
 * under the loop origin this `HeadInput` names. There is no scratch database to
 * open and none to unlink — the head's rows are its own actor-keyed rows in the
 * workspace's one store, so a parent can read what its own fork did — and
 * releasing the seat drops the runtime objects and retires the directory row
 * while the rows themselves stay.
 */
async function runLocalHead(input: HeadInput, deps: CLIHeadRuntimeDeps, signal: AbortSignal): Promise<HeadReport> {
  const capture = new HeadCapture();
  // The capture's own file observer, handed to the seat so the runtime the HOST
  // builds is the one being watched. `HeadReport.fileChanges` is
  // `capture.files.snapshot()` and nothing else fills it, so a seat built
  // without this reports that the head changed nothing however much it wrote.
  const seat = await deps.hostHead(input, capture.files);
  try {
    const rt = seat.actor.runtime;
    // execute_tools over the head's OWN router providers (its own home in the
    // one file plane + the parent's real `laptop.*`) plus the web/llm codemode
    // namespaces, `state.*` over the head's own program state and `db.*` over
    // the head's own app data — the shared description promises both to every
    // program, and the hosted head binds the same providers over its own
    // actor-keyed rows. `state.*` is bound off `seat.actor.handle`, never the
    // parent's: a fork's markers are its own rows, and a head that wrote into
    // its parent's program state would be one actor moving another's. A
    // function of the finished head surface, the shape buildHeadToolSet
    // resolves after its own filtering, so `tools.<name>` declares and binds
    // exactly the tools this head holds.
    const sandbox = createNodeExecuteToolFactory({
      extraProviders: [
        ...deps.codemodeExtras(),
        createStateCodemodeProvider(seat.actor.handle.programState),
        createDbCodemodeProvider(seat.actor.stores.appData),
      ],
    });
    const executeTool = (finished: ToolSet) => sandbox({
      native: finished,
      // A head reads the workspace's crafted tools through its own router; it
      // crafts none of its own for the length of one fork.
      craftedTools: () => ({}),
      providers: rt.executionRouter?.getProviders() ?? [],
    });
    const tools = buildHeadToolSet({
      input,
      capture,
      rt,
      executeTool,
      webSearch: deps.webSearch,
      split: (request) => runLocalSplit(request, input, deps),
    });
    const mission = localMissionScope(deps.governor(), input.missionLabels ?? []);
    const journal = deps.journal();
    const inferenceOptions: Parameters<typeof runHeadInference>[1] = {
      // THE CLAIMED LOOP. `actor` carries the session every iteration is
      // admitted on, `runId` the run its claims attribute to, `profile` the
      // same authority a chat turn resolves through, and `dynamic` this head's
      // own live context — so a fork's turn is durable, pinned and cancellable
      // exactly like the parent's.
      actor: seat.actor,
      runId: seat.runId,
      profile: seat.profile,
      dynamic: seat.dynamic,
      model: headModel(input, deps), tools, capture,
      workspaceLayout: 'shared-workspace',
      signal,
      isAborted: () => signal.aborted,
      abortReason: () => signal.aborted ? renderThrownChain({ cause: signal.reason }) : null,
      // Each finished step into the session's journal as it lands — the only
      // thing that can say what a head is doing before it reports.
      reportStep: (seq, step) => journal.appendStep(input.id, seq, step),
    };
    if (mission) inferenceOptions.mission = mission;
    return await runHeadInference(input, inferenceOptions);
  } finally {
    await seat.release();
  }
}

/** Child reports and steps remain in the root journal after a head's seat ends. */
async function runLocalSplit(
  request: HeadSplitRequest,
  input: HeadInput,
  deps: CLIHeadRuntimeDeps,
): Promise<HeadSplitResult> {
  const controller = new HeadController(createCLIHeadRuntime(deps), deps.journal());
  const controllerInput: Parameters<HeadController['run']>[0] = {
    parentHeadId: input.id,
    parentDepth: input.depth,
    rootId: input.rootId,
    inheritedContext: input.inheritedContext,
    request: { rationale: request.rationale, heads: request.heads, mergeStrategy: request.mergeStrategy },
    parentBudget: input.budget,
    model: input.model,
    mode: input.mode,
    // A subtree charges the same mission its root does — otherwise a head
    // escapes its budget simply by splitting again.
  };
  if (input.missionLabels?.length) controllerInput.missionLabels = input.missionLabels;
  const result = await controller.run(controllerInput);
  return {
    narrative: result.mergedNarrative,
    decisions: result.selectedDecisions,
    unresolvedQuestions: result.unresolvedQuestions,
    blindSpots: result.blindSpots,
    childHeadIds: result.headIds,
    headCount: result.costSummary.headCount,
  };
}
