// createCLIHeadRuntime — the local HeadRuntime backing the `agents` tool's fork
// action. The cf backend runs heads as ExplorationAgent Facets; locally each
// head runs IN-PROCESS over a FORK of the parent runtime (buildCLIHeadRuntime):
// the parent's real host executor (`run laptop` / codemode `laptop.*`), the
// parent's files at /workspace + /pc, and a PRIVATE durable scratch (its own
// in-memory SqliteFS /local, Memory, CraftStore, and emulated `workspace`
// shell) so siblings can't corrupt each other. Heads are LLM-bound, so the
// HeadController's Promise.all gives real concurrency without subprocesses; the
// merge LLM runs in this process.
//
// The tool surface is the SAME backend-agnostic buildHeadToolSet the cf Facet
// uses: `run` + `execute_tools` + `web` (the parent's vocabulary, so a fork's
// allowedTools maps onto real tools) + record_evidence/record_decision +
// split_subheads (recursive nested HeadController, depth-budgeted).

import { generateText, type LanguageModel } from 'ai';
import {
  type HeadRuntime, type HeadGrounding, type SpawnedHead, type HeadInput, type HeadReport, type MergeOutput,
  type WebSearchProvider, type AgentRuntime, type CodemodeProvider,
  type HeadSplitRequest, type HeadSplitResult,
  HeadCapture, runHeadInference, buildHeadToolSet, HeadController, HeadJournal, initHeadsTables,
  extractJsonObject, reasoningEffortOptions, resolveMaxSteps,
} from '@proteus/core';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw, buildCLIHeadRuntime } from './runtime.js';
import { createNodeExecuteToolFactory } from './execute-tools-factory.js';

export interface CLIHeadRuntimeDeps {
  model: LanguageModel;
  /** Provider prefix from the normalized model spec. */
  providerFamily?: string;
  /** The parent session's runtime — the real execution surface every head forks
   *  (host executor, files, llm/executor/schedule, checkpoints). */
  parentRuntime: AgentRuntime;
  /** The directory the CLI was invoked in — the head's /workspace root, where
   *  the task's files live. */
  cwd: string;
  /** The shared web research provider — same seam the main loop uses. Backs the
   *  head's `web` tool. */
  webSearch: WebSearchProvider;
  /** Extra codemode namespaces spliced into the head's execute_tools sandbox —
   *  `web.*` and `llm.query`, WITHOUT `agents.*`/`agent.*`: a head forks its
   *  parent's resources, never its authority to delegate. */
  codemodeExtras: () => CodemodeProvider[];
  /** Execution-grounding seam — the same executor + judge the MCTS engine uses,
   *  so head outcomes + the merge are grounded, not heuristic. Omit ⇒ neutral
   *  scores + n=1 merge. */
  grounding?: HeadGrounding;
}

/** Per-head abort flag — flipped by SpawnedHead.abort (a caller-requested
 *  deadline, or the parent giving up on the split). */
interface AbortFlag { aborted: boolean; reason: string | null; }

export function createCLIHeadRuntime(deps: CLIHeadRuntimeDeps): HeadRuntime {
  return {
    async spawnHead(input: HeadInput): Promise<SpawnedHead> {
      const flag: AbortFlag = { aborted: false, reason: null };
      return {
        id: input.id,
        run: () => runLocalHead(input, deps, flag),
        async abort(reason: string) { flag.aborted = true; flag.reason = reason; },
      };
    },
    mergeLLM: (prompt) => mergeViaLLM(deps.model, prompt, deps.providerFamily),
    ...(deps.grounding ? { grounding: deps.grounding } : {}),
  };
}

/** Run one head in-process over a fork of the parent runtime. */
async function runLocalHead(input: HeadInput, deps: CLIHeadRuntimeDeps, flag: AbortFlag): Promise<HeadReport> {
  const db = new Database(':memory:');
  try {
    const rt = buildCLIHeadRuntime(db, {
      parentRuntime: deps.parentRuntime,
      cwd: deps.cwd,
      agentId: input.id,
      agentName: `head-${input.id.slice(0, 8)}`,
    });
    const capture = new HeadCapture();
    // execute_tools over the head's OWN router providers (private `workspace.*`
    // + the parent's real `laptop.*`) plus the web/llm codemode namespaces.
    const executeTool = createNodeExecuteToolFactory({ extraProviders: deps.codemodeExtras() })({
      // A head's CraftStore is a throwaway in-memory fork: no crafted tools.
      craftedTools: () => ({}),
      providers: rt.executionRouter?.getProviders() ?? [],
      loader: { __cli: true },
    });
    const tools = buildHeadToolSet({
      input,
      capture,
      rt,
      executeTool,
      webSearch: deps.webSearch,
      split: (request) => runLocalSplit(request, input, deps),
    });
    return await runHeadInference(input, {
      model: deps.model, tools, capture,
      // The same envelope the parent session's turn runs to — local-session
      // reads this identical shell variable. A fork of a turn gets the turn's room.
      maxSteps: resolveMaxSteps(process.env.PROTEUS_MAX_STEPS),
      isAborted: () => flag.aborted,
      abortReason: () => flag.reason,
    });
  } finally {
    db.close();
  }
}

/** split_subheads — a head spawns 2-4 child heads recursively (depth-budgeted;
 *  the gate lives in buildHeadToolSet), their findings merged into one narrative.
 *  In-process: a nested HeadController over a fresh CLI head runtime sharing the
 *  same parent runtime + model + web. */
async function runLocalSplit(request: HeadSplitRequest, input: HeadInput, deps: CLIHeadRuntimeDeps): Promise<HeadSplitResult> {
  const db = new Database(':memory:');
  try {
    initHeadsTables(makeExecRaw(db));
    const controller = new HeadController(createCLIHeadRuntime(deps), new HeadJournal(makeSql(db)));
    const result = await controller.run({
      parentHeadId: input.id,
      rootId: input.rootId,
      inheritedContext: input.inheritedContext,
      request: { rationale: request.rationale, heads: request.heads, mergeStrategy: request.mergeStrategy },
      parentBudget: input.budget,
      model: input.model,
    });
    return {
      narrative: result.mergedNarrative,
      decisions: result.selectedDecisions,
      unresolvedQuestions: result.unresolvedQuestions,
      childHeadIds: result.headIds,
      headCount: result.costSummary.headCount,
    };
  } finally {
    db.close();
  }
}

/** The merge synthesis call — return parsed JSON; the HeadController validates it
 *  against MergeOutputSchema and falls back on a bad/throwing response. */
async function mergeViaLLM(model: LanguageModel, prompt: string, providerFamily?: string): Promise<MergeOutput> {
  const providerOptions = reasoningEffortOptions('low', providerFamily ?? '');
  const { text } = await generateText({
    model,
    prompt,
    ...(providerOptions ? { providerOptions } : {}),
  });
  return extractJsonObject(text) as MergeOutput;
}
