// createCLIHeadRuntime — the local HeadRuntime backing the `agents` tool's fork
// action. The cf backend runs heads as SubordinateAgent facets in head mode; locally each
// head runs IN-PROCESS over a FORK of the parent runtime (buildCLIHeadRuntime):
// the parent's real host executor (`run laptop` / codemode `laptop.*`), the
// parent's canonical workspace through `parent.*`, and a PRIVATE durable
// scratch (its own workspace filesystem, Memory, CraftStore and shell) so
// siblings can't corrupt each other. Heads are LLM-bound, so the
// HeadController's Promise.all gives real concurrency without subprocesses; the
// merge LLM runs in this process.
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
  HeadCapture, runHeadInference, buildHeadToolSet, HeadController, type HeadJournal, headAgentName,
  createStateCodemodeProvider,
  headMergeLLM,
  localMissionScope,
} from '@kinu.run/core';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildCLIHeadRuntime, cleanupFacetCwdScratch, type CLIRuntime } from './runtime';
import { createNodeExecuteToolFactory } from './execute-tools-factory';
import { kinuHome } from './home';

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
  /** Resolve a per-fork model spec (`HeadInput.model`) to a model. Without it
   *  every head runs `model` above, which made the per-fork `model` field —
   *  advertised on the `agents` fork schema and honoured by the cf backend —
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
}

/** Per-head abort flag — flipped by SpawnedHead.abort (a caller-requested
 *  deadline, or the parent giving up on the split). */
interface AbortFlag { aborted: boolean; reason: string | null; }

export function createCLIHeadRuntime(deps: CLIHeadRuntimeDeps): HeadRuntime {
  const runtime: HeadRuntime = {
    async spawnHead(input: HeadInput): Promise<SpawnedHead> {
      const flag: AbortFlag = { aborted: false, reason: null };
      return {
        id: input.id,
        run: () => runLocalHead(input, deps, flag),
        async abort(reason: string) { flag.aborted = true; flag.reason = reason; },
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

/**
 * A local head's private scratch store.
 *
 * A cf head's `/local` is its FACET's own SQLite — real storage, sized by the
 * DO's quota rather than by whatever is left of a process. The local head's was
 * `new Database(':memory:')`, which put the whole scratch — filesystem pages, the
 * FTS5 memory index, the CraftStore — in the CLI process heap, shared with the
 * parent session and with every sibling head running concurrently in that same
 * process. A file gives both backends the same answer: SQLite pages to disk, so
 * a fork that writes a large artifact to /local costs disk rather than the
 * session's heap.
 *
 * Isolated by construction (one file per head id, and a head id is unique
 * within a run) and removed when the head's work is finished, so scratch never
 * accumulates. The id is sanitized because it names a path: it is generated by
 * the controller today, but a path built from an identifier must not be the
 * place that assumes so.
 */
interface HeadScratch {
  db: Database;
  dispose(): void;
}

function openHeadScratch(headId: string): HeadScratch {
  const dir = join(kinuHome(), 'heads');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${headId.replace(/[^A-Za-z0-9_-]/g, '_')}.db`);
  const db = new Database(path, { create: true });
  return {
    db,
    dispose() {
      db.close();
      // The sidecars exist only under WAL/hot journals; `force` covers absence.
      for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true });
    },
  };
}

/** Run one head in-process over a fork of the parent runtime. */
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

async function runLocalHead(input: HeadInput, deps: CLIHeadRuntimeDeps, flag: AbortFlag): Promise<HeadReport> {
  const scratch = openHeadScratch(input.id);
  const db = scratch.db;
  const agentName = headAgentName(input.id);
  try {
    const capture = new HeadCapture();
    const rt = buildCLIHeadRuntime(db, {
      parentRuntime: deps.parentRuntime,
      agentId: input.id,
      agentName,
      writeObserver: capture.files,
    });
    // execute_tools over the head's OWN router providers (private `workspace.*`
    // + the parent's real `laptop.*`) plus the web/llm codemode namespaces and
    // `state.*` over the head's own scratch, the table initActorTables created:
    // the shared description promises `state.set`/`state.get` to every
    // program, and the hosted head binds the same provider over its facet's
    // SQL. A function of the finished head surface, the shape buildHeadToolSet
    // resolves after its own filtering, so `tools.<name>` declares and binds
    // exactly the tools this head holds.
    const sandbox = createNodeExecuteToolFactory({
      extraProviders: [...deps.codemodeExtras(), createStateCodemodeProvider(rt.storage.sql)],
    });
    const executeTool = (finished: ToolSet) => sandbox({
      native: finished,
      // A head's CraftStore is a throwaway in-memory fork: no crafted tools.
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
      model: headModel(input, deps), tools, capture,
      workspaceLayout: 'private-scratch',
      isAborted: () => flag.aborted,
      abortReason: () => flag.reason,
      // Each finished step into the session's journal as it lands — the only
      // thing that can say what a head is doing before it reports.
      reportStep: (seq, step) => journal.appendStep(input.id, seq, step),
    };
    if (mission) inferenceOptions.mission = mission;
    return await runHeadInference(input, inferenceOptions);
  } finally {
    scratch.dispose();
    if (deps.parentRuntime.cwd) cleanupFacetCwdScratch(deps.parentRuntime.cwd, agentName);
  }
}

/** Child reports and steps remain in the root journal after their private storage is released. */
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
