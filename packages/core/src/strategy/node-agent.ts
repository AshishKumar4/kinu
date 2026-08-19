/**
 * ONE NODE OF A SWARM, AS AN AGENT — EXPLORATION-SPEC §8.1.
 *
 * A node used to be one `generateText` call whose whole output was text. §8.1 says
 * normatively that a node is an agent, and lists the six things that makes it: a
 * tool loop with a stop condition, a tool surface, no delegation authority, its own
 * model, its own transcript, and its own workspace. This module is five of those
 * six; the sixth is {@link nodeWorkspace}, which reports honestly that it is not
 * built yet.
 *
 * WHAT IS NOT HERE, AND WHY THAT MATTERS MORE THAN WHAT IS. There is no loop in
 * this file. The loop is {@link runHeadInference}, which already ends on abort, on
 * a step envelope and on an exhausted budget, already meters per step off the
 * provider's own report, already charges a mission ledger between steps, already
 * pushes an ordered trace to a sink while it runs, and already refuses to present a
 * mid-flight thought as a finished answer. A node needs every one of those and
 * needs none of them differently. What a node needs differently is its PROMPT — a
 * search's framing rather than a fork's — which is the one dep this work added to
 * that function. A second loop beside it would be the parallel-implementation
 * defect this repository deletes, and it would be the version without the
 * mid-flight guard.
 *
 * WHAT A NODE IS GRADED ON IS WHAT IT REPORTS, never what it changed. Nodes share
 * one file plane until §8.6's substrate lands ({@link NodeWorkspace.isolation}), so
 * a diff of the workspace attributes nothing: every node changed the same tree.
 * The engine writes the REPORTED candidate to the verifier's path and measures
 * that, one node at a time. This is the constraint the delegation doctrine used to
 * state as the reason a graded node could not hold tools at all; it is a constraint
 * on the GRADING SIGNAL, not on the tool surface, and separating the two is what
 * made this commit possible.
 *
 * THE REPORT IS CONSUMED THROUGH ONE FUNCTION. §8.7's grading report — its retry
 * bound, its terminal set, its verifier immutability — is still being specified, so
 * {@link readNodeReport} is the whole boundary: it takes what a node's loop
 * produced and returns the candidate and the conclusion the engine needs. Today
 * that is the existing `report` tool's status-and-content shape plus the loop's own
 * final text. When the grading fields land, this one function changes and nothing
 * else does.
 */

import { jsonSchema, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { HEAD_BUILTIN_TOOLS, keepBuiltins } from '../heads/head-tools';
import { HeadCapture, runHeadInference, withHeadCaptureRecording } from '../heads/head-inference';
import type { HeadInferenceDeps } from '../heads/head-inference';
import { buildBuiltinTools } from '../tools/builtins';
import type { BuiltinToolDeps } from '../tools/builtins';
import { readProposalCode } from '../execution/code-fence';
import { nodeWorkspace, isolationDisclosure } from './node-workspace';
import { BRANCH_PROPOSAL_WIDTH, SWARM_CONTEXTS } from './swarm';
import type { Logger } from '../obs/index';
import type { Usage } from '../usage';
import type { BranchContext, SwarmSettle } from './swarm';
import type { BranchDecision } from './swarm-budget';
import type { NodeIdentity, NodeIsolation, NodeWorkspaceProvisioner } from './node-workspace';
import type {
  CapturedReport, NodeArbiter, NodeLoopHost, NodeLoopResult, NodeRunSpec,
} from './node-host';
export type {
  CapturedReport, NodeArbiter, NodeLoopHost, NodeLoopResult, NodeRunSpec,
} from './node-host';
import type { HeadBudget, HeadInput, HeadReport, HeadStep, SerializedMessage } from '../heads/types';
import type { HeadJournal } from '../heads/journal';
import type { MissionScope } from '../mission-budget';
import type { AgentRuntime } from '../types/agent-runtime';
import type { WebSearchProvider } from '../web/index';
import type { WorkMode } from '../prompting/surface';
import type { ModelCallSink } from '../events/model-call';

/**
 * A node's builtin surface: a head's four, plus the report through which it
 * finishes.
 *
 * Derived from {@link HEAD_BUILTIN_TOOLS} rather than re-listed, so the two
 * confined surfaces cannot drift — §8.1 rule 2 defines a node's set as a head's
 * plus the report and the proposal, and the proposal is not a builtin.
 *
 * `agents` IS ABSENT AND ITS ABSENCE IS STRUCTURAL. It is not in this list, and it
 * is also not buildable: a node's toolset is assembled with no `agents` dep at all,
 * which is the same mechanism that confines subordinates. §8.1 rule 3 — a node's
 * only route to more actors is the proposal, which the engine arbitrates, so a node
 * cannot fund work outside the search's budget.
 */
export const NODE_BUILTIN_TOOLS = [...HEAD_BUILTIN_TOOLS, 'report'] as const;

/** The node's own branch route. One name, so reading a transcript tells a human
 *  which tool asked for budget. */
export const PROPOSE_BRANCH_TOOL = 'propose_branch';


/** What the engine hands one node before it runs. Identity and depth come from the
 *  engine's own row — a node states neither (§8.3) — and the seed is assembled by
 *  the engine because §8.4 makes the seed the engine's to author, never the
 *  parent's. */
export interface NodeAgentInput extends NodeIdentity {
  readonly parentId: string | null;
  /** The pinned task block, verbatim at every depth (§8.4). Also the journal's own
   *  record of what this node was asked. */
  readonly task: string;
  /** Why this node exists: the search's own task at the root, the accepted
   *  branch's rationale below it. */
  readonly rationale: string;
  /** The search's half of the system prompt — the objective, the angle, the
   *  criteria. The node's own half (what it is graded on, what its plane is) is
   *  added by {@link nodeSystemPrompt}, which is why this is `base` and not
   *  `system`: only the node knows which tools it ended up with. */
  readonly base: string;
  /** The conversation this node runs on: the inherited prefix and the seed,
   *  assembled by the engine, task last. */
  readonly messages: readonly ModelMessage[];
  /** The conversation this node inherited, as the journal records it. Empty under
   *  `context:'fresh'`, which is that value's entire definition. */
  readonly inherited: readonly SerializedMessage[];
  readonly context: BranchContext;
  readonly mode: WorkMode;
  /** How this search settles, for the journal's own label column. */
  readonly settle: SwarmSettle;
  /**
   * Arbitrate this node's branch request, or null when a branch could not be
   * granted at this node whatever it asked.
   *
   * NULL MEANS THE TOOL IS ABSENT, not present-and-refusing. §8.2's build-time
   * rule, which `head-tools.ts` already applies to `split_subheads`: a request
   * that can only ever be refused MUST NOT be offered, because offering it spends
   * a step to learn a limit the surface already knew. The runtime refusal stays
   * for what can still change mid-run — the budget can empty between the
   * invitation and the answer, which is why this is a function and not a boolean.
   */
  readonly arbitrate: NodeArbiter | null;
}

/** What a node's own run produced, as the engine consumes it. */
export interface NodeRun {
  /** The loop's full report: status, summary, per-step count, usage, tool calls.
   *  Journalled in full; the engine reads the two fields below out of it. */
  readonly report: HeadReport;
  /** What gets measured: the candidate this node REPORTED, code-fenced content
   *  first and the whole conclusion otherwise. */
  readonly candidate: string;
  /** The branch this node was granted, if it asked and the arbiter paid. */
  readonly granted: BranchDecision | null;
  readonly usage: Usage;
  readonly isolation: NodeIsolation;
  /** Whether the node finished through its own `report` call rather than by
   *  running out of things to say. Reported because a search whose nodes never
   *  report is a search grading final prose, and nothing would otherwise say so. */
  readonly reportedItself: boolean;
  /**
   * The conversation this node produced, in order.
   *
   * What a `context:'fork'` child inherits, appended to what this node itself
   * inherited — §8.4's append-only rule, which is a decision about caching: the
   * prefix every sibling shares is byte-identical, so a provider can cache it once
   * for the whole level.
   */
  readonly produced: readonly ModelMessage[];
}

/**
 * The deps a run assembles once and hands to every node.
 *
 * MUTABLE, unlike every other input shape here, and the reason is the rule about absent
 * keys: six of these are optional, an absent one must be an ABSENT KEY rather than a key
 * holding `undefined`, and building that with conditional spreads is the shape the lint
 * rule refuses. So the run fills this in statements. Nothing mutates it after the loop
 * starts.
 */
export interface NodeAgentDeps {
  rt: AgentRuntime;
  model: LanguageModel;
  /** Where the node's transcript lands. §8.8: a read model over the node's
   *  journal, never a second store. */
  journal: HeadJournal;
  /** The step envelope this node runs to — the search's, not a private pool. */
  maxSteps: number;
  logger: Logger;
  signal?: AbortSignal;
  reportModelCall?: ModelCallSink;
  mission?: MissionScope;
  /** The node's home provisioner. Absent is a host with no uid-0 view, and then
   *  the shared plane is REPORTED — see {@link nodeWorkspace}. */
  provisionHome?: NodeWorkspaceProvisioner;
  /**
   * Where this node's loop RUNS, when somewhere other than here.
   *
   * Absent runs {@link runNodeLoop} in this isolate, which is the whole of the
   * difference: the body is the same function either way, so a host is a
   * TRANSPORT and never a second runtime. Present hands the node to a host that
   * gives it its own storage and its own shell state — on the Cloudflare backend
   * an `ExplorationAgent` facet, the same host a fork's head already runs in.
   *
   * What a host does NOT buy is parallelism. `do.facet.cpu_shared` is the
   * governing fact: facets of one object share a single execution thread, so
   * hosting a wave of nodes serialises exactly as `Promise.allSettled` in one
   * isolate already does. It buys a storage boundary and a teardown verb. The
   * FILE boundary is independent of it and needs no host at all, because a home
   * is uid/gid/mode on real inodes in the one view and a credential is an
   * argument to `exec`.
   */
  host?: NodeLoopHost;
  /** Backend-built `execute_tools`; absent on a runtime that wired none, and then
   *  the tool is absent too rather than broken. */
  executeTool?: unknown;
  webSearch?: WebSearchProvider;
  /** A caller-requested deadline for one node, carried into the loop's own stop
   *  condition. Absent means the node runs until it finishes or the search aborts. */
  maxWallClockMs?: number;
}





/**
 * The live seams {@link runNodeLoop} needs and a {@link NodeRunSpec} cannot
 * carry: a model, a runtime, and the two callbacks that reach the search while
 * the node is still running.
 *
 * In this isolate they are plain functions. In a facet they are RPCs to the
 * parent, assembled host-side — the same shape `mission.port` already takes.
 */
export interface NodeLoopDeps {
  rt: AgentRuntime;
  model: LanguageModel;
  logger: Logger;
  signal?: AbortSignal;
  mission?: MissionScope;
  /** Where each finished step lands WHILE the node still runs. */
  reportStep?: (seq: number, step: HeadStep) => Promise<void> | void;
  /** The search's arbiter, or null when no branch could be granted. */
  arbitrate: NodeArbiter | null;
  executeTool?: unknown;
  webSearch?: WebSearchProvider;
}

/** Where a node's own report and its granted branch land while it runs. A holder
 *  rather than two closed-over `let`s: the tools that write it and the code that
 *  reads it are in different functions, and one object makes that traffic
 *  visible. */
interface NodeScratch {
  reported: CapturedReport | null;
  granted: BranchDecision | null;
  produced: readonly ModelMessage[];
}

/**
 * The proposal tool: §8.2's contract as a tool, so the verdict is a RETURN VALUE.
 *
 * *"An agent node proposes by calling a tool, so the verdict is that tool's return
 * value. The node reads it, and the refusal's text is its next instruction."* That
 * is the half a thought node cannot have — it has no tool to return through, so its
 * verdict is a typed diagnostic event — and it is why a refusal's prose is written
 * for the node rather than for the log.
 */
function buildProposeTool(
  arbitrate: NodeArbiter,
  scratch: NodeScratch,
): ToolSet {
  return {
    [PROPOSE_BRANCH_TOOL]: tool({
      description:
        `Ask the search to spend part of its budget exploring ${String(BRANCH_PROPOSAL_WIDTH.min)}-`
        + `${String(BRANCH_PROPOSAL_WIDTH.max)} narrower threads of your task. You are PROPOSING, `
        + 'not spawning: the search decides against a depth cap and a shared budget you cannot see, '
        + 'and this call returns either the children it reserved or the reason it refused. Each '
        + 'branch names what it starts from — "fork" gives it your whole conversation, "fresh" gives '
        + 'it your report and its own focus. Call it at most once, when one thread genuinely '
        + 'deserves its own budget.',
      inputSchema: jsonSchema<{
        rationale: string;
        branches: Array<{ task: string; rationale: string; context?: BranchContext }>;
      }>({
        type: 'object',
        required: ['rationale', 'branches'],
        properties: {
          rationale: { type: 'string' },
          branches: {
            type: 'array',
            minItems: BRANCH_PROPOSAL_WIDTH.min,
            maxItems: BRANCH_PROPOSAL_WIDTH.max,
            items: {
              type: 'object',
              required: ['task', 'rationale', 'context'],
              properties: {
                task: { type: 'string' },
                rationale: { type: 'string' },
                context: { type: 'string', enum: [...SWARM_CONTEXTS] },
              },
            },
          },
        },
      }),
      execute: async ({ rationale, branches }): Promise<string> => {
        // The band is enforced by the arbiter and not by this schema, for
        // `BRANCH_PROPOSAL_WIDTH`'s own reason: an out-of-range request must
        // produce a reason-coded refusal the node can act on rather than being
        // unrepresentable and therefore unexplainable. `minItems`/`maxItems` are a
        // hint to the provider, and the AI SDK does not validate a `jsonSchema`
        // tool input at all.
        const decision = await arbitrate({
          rationale,
          branches: branches.map((branch) => ({
            task: branch.task,
            rationale: branch.rationale,
            // An absent `context` NARROWS. A node that did not say what its child
            // starts from has not asked for the parent's whole conversation, and
            // defaulting the other way would widen inheritance on silence.
            context: branch.context ?? 'fresh',
          })),
        });
        if (decision.kind === 'refused') return `Refused (${decision.policy}): ${decision.error}`;
        scratch.granted = decision;
        return `Granted: ${String(decision.width)} children reserved (${decision.nodeIds.join(', ')}). `
          + 'They are created when you finish and report, and they receive your report as their seed, '
          + 'so put in it what they will need.';
      },
    }),
  };
}

/**
 * The node's tool surface: the confined builtins, the report it finishes through,
 * and the proposal when one could be granted.
 *
 * The report tool comes out of the SAME `buildBuiltinTools` call as the rest,
 * through its own dep, so a node and a subordinate get one tool with one
 * dispatcher and one vocabulary rather than a second definition that validates its
 * two arguments differently — the exact defect `report-tool.ts` was factored out to
 * remove.
 *
 * Every call is wrapped into the capture, so the transcript records what the node
 * DID and not only what it said — which is the difference between a node a human
 * can audit and a paragraph of prose.
 */
function buildNodeToolSet(input: {
  readonly deps: NodeLoopDeps;
  readonly capture: HeadCapture;
  readonly scratch: NodeScratch;
  readonly arbitrate: NodeArbiter | null;
}): ToolSet {
  const { deps, scratch } = input;
  const builtinDeps: BuiltinToolDeps = {
    rt: deps.rt,
    logger: deps.logger,
    report: {
      report: async ({ status, content }) => {
        scratch.reported = { status, content };
        return { received: true };
      },
    },
  };
  // Assigned rather than spread conditionally: an absent dep must be an ABSENT KEY, and
  // a key written as `undefined` is a different fact from a key nobody set — which is the
  // distinction `buildBuiltinTools` reads to decide whether a tool exists at all.
  if (deps.executeTool !== undefined) builtinDeps.preBuiltExecuteTool = deps.executeTool;
  if (deps.webSearch !== undefined) builtinDeps.webSearch = deps.webSearch;
  const surface: ToolSet = keepBuiltins(buildBuiltinTools(builtinDeps), NODE_BUILTIN_TOOLS);
  if (input.arbitrate) {
    Object.assign(surface, buildProposeTool(input.arbitrate, scratch));
  }
  return withHeadCaptureRecording(surface, input.capture);
}

/**
 * THE REPORT SEAM. Everything the engine takes out of a finished node passes
 * through here.
 *
 * §8.7's grading mechanism is not settled — the retry bound, the exact terminal set,
 * and whether merge-back refuses a transaction are all still being decided — so this
 * consumes the report at the shape that exists today and nothing further: the node's
 * own `report` call when it made one, and the loop's final text otherwise. It
 * computes NO score. §3.3 is why: a node does not grade itself, so the quantity a
 * node would have to lie about is one it never supplies.
 *
 * The fence is read for the same reason the toolless path reads it: a candidate that
 * arrives inside a code fence is code, and the instrument runs code. A fence in a
 * language the executor cannot run is kept WHOLE rather than dropped, because it is
 * still the node's answer and the measurement will say so with the instrument's own
 * reason.
 */
/** What the engine takes out of a finished node: the candidate the instrument measures,
 *  and the conclusion a child's seed carries. No score — §3.3, a node does not grade
 *  itself, so the quantity it would have to lie about is one it never supplies. */
export interface NodeReport {
  readonly candidate: string;
  readonly conclusion: string;
}

export function readNodeReport(input: {
  readonly report: HeadReport;
  readonly reported: CapturedReport | null;
  readonly languages: readonly [string, ...string[]];
}): NodeReport {
  const conclusion = input.reported?.content.trim() || input.report.summary.trim();
  const code = readProposalCode(conclusion, input.languages);
  return {
    candidate: code?.kind === 'runnable' ? code.code : conclusion,
    conclusion,
  };
}

/**
 * The node's system prompt: what it is, what it may touch, and what it is graded on.
 *
 * Deliberately NOT the head prompt. A head is told it was forked from a canonical
 * workspace, that it accumulates findings through `record_evidence`, and whether it
 * may split — three things that are either false or meaningless for a node. What a
 * node needs instead is the grading contract: it is measured on what it REPORTS, its
 * siblings are running beside it right now, and the plane it shares with them is not
 * attributable to it.
 */
export function nodeSystemPrompt(input: {
  readonly base: string;
  readonly isolation: NodeIsolation;
  readonly home: string;
  readonly toolNames: readonly string[];
}): string {
  const parts = [
    input.base,
    isolationDisclosure(input.isolation, input.home),
    'You are ONE node of a search. Other nodes are working on sibling angles of the same task at '
    + 'the same time, and the search compares what each of you REPORTS — not the state you leave '
    + 'behind. So use your tools to find things out, then finish by calling `report` with '
    + 'status:"completed" and your answer as `content`. An answer that exists only in the workspace '
    + 'or only in your reasoning is an answer the search cannot see.',
  ];
  if (input.toolNames.includes(PROPOSE_BRANCH_TOOL)) {
    parts.push(
      `If one thread of this task genuinely deserves its own budget, call \`${PROPOSE_BRANCH_TOOL}\` `
      + 'once before you report. It answers with the children it reserved or the reason it refused, '
      + 'and a refusal is your next instruction rather than something to retry.',
    );
  }
  parts.push(`Tools available to you: ${input.toolNames.join(', ')}. There are no others — in `
    + 'particular you cannot delegate to another agent, because the search owns that decision.');
  return parts.join('\n\n');
}

/**
 * THE NODE LOOP. One body, wherever a node runs.
 *
 * Exported because a host calls it too: on the Cloudflare backend an
 * `ExplorationAgent` facet receives a {@link NodeRunSpec} over RPC, rebuilds the
 * live seams against its own runtime, and calls exactly this function. So a
 * hosted node and an in-process node are not two implementations that must be
 * kept in step — they are one function reached by two transports, which is the
 * only arrangement that cannot drift.
 *
 * It journals NOTHING. The ledger belongs to the search, which is on the other
 * side of the boundary when a host is in play, and a loop that wrote to its own
 * copy would be the second store the journal rule forbids.
 */
export async function runNodeLoop(
  spec: NodeRunSpec,
  deps: NodeLoopDeps,
): Promise<NodeLoopResult> {
  const capture = new HeadCapture();
  const scratch: NodeScratch = { reported: null, granted: null, produced: [] };
  // The arbiter is offered only when the search said a branch could be granted.
  // Both halves are required: a host's arbiter is an RPC stub and therefore
  // always non-null, so presence alone cannot answer whether to offer the tool.
  const tools = buildNodeToolSet({
    deps,
    capture,
    scratch,
    arbitrate: spec.canPropose ? deps.arbitrate : null,
  });

  const inference: HeadInferenceDeps = {
    model: deps.model,
    tools,
    // The layout the node is TOLD matches the boundary it actually got, and the
    // prompt says the same thing in its own words through `isolationDisclosure`,
    // so the two cannot disagree.
    workspaceLayout: spec.isolation === 'private-home' ? 'private-scratch' : 'shared-workspace',
    capture,
    maxSteps: spec.maxSteps,
    isAborted: () => deps.signal?.aborted ?? false,
    abortReason: () => (deps.signal?.aborted ? 'the search was aborted' : null),
    framing: {
      system: nodeSystemPrompt({
        base: spec.base,
        isolation: spec.isolation,
        home: spec.home,
        toolNames: Object.keys(tools),
      }),
      messages: spec.messages,
    },
    reportMessages: (messages) => { scratch.produced = messages; },
  };
  // Assigned rather than spread: an absent seam must be an ABSENT KEY, because
  // `runHeadInference` reads presence to decide whether the behaviour exists.
  if (deps.mission !== undefined) inference.mission = deps.mission;
  if (deps.reportStep !== undefined) inference.reportStep = deps.reportStep;

  const report = await runHeadInference(spec.headInput, inference);
  return {
    report,
    reported: scratch.reported,
    granted: scratch.granted,
    produced: scratch.produced,
  };
}

/**
 * Run one node as an agent, and journal it.
 *
 * Never throws: the loop turns a provider failure into an `errored` report, and a
 * node that errored is a candidate the search could not measure rather than a run
 * that stops. The engine decides what an unmeasurable candidate means; this
 * function's contract is that it always returns one.
 *
 * This function owns everything the loop must not: the home, the ledger, and the
 * decision of WHERE the loop runs. The loop owns the inference and nothing else.
 */
export async function runNodeAgent(
  input: NodeAgentInput,
  deps: NodeAgentDeps,
): Promise<NodeRun> {
  const home = await nodeWorkspace(
    { nodeId: input.nodeId, rootId: input.rootId, depth: input.depth },
    deps.provisionHome,
  );
  // `maxDepth: 1` means "this node itself may run", and that is the whole of what a
  // node's own budget governs. Recursion is not a node's to spend — the arbiter owns
  // depth, and a node at the search's depth cap must still do its work rather than being
  // stopped before its first step, which is what a depth of 0 would do here
  // (`budgetExhausted` treats it as exhausted). Assigned rather than spread, so an
  // undeclared deadline is an ABSENT key.
  const nodeBudget: HeadBudget = deps.maxWallClockMs === undefined
    ? { maxDepth: 1, spawnedAt: Date.now() }
    : { maxDepth: 1, spawnedAt: Date.now(), maxWallClockMs: deps.maxWallClockMs };

  const headInput: HeadInput = {
    id: input.nodeId,
    rootId: input.rootId,
    parentId: input.parentId,
    depth: input.depth,
    task: input.task,
    mode: input.mode,
    rationale: input.rationale,
    inheritedContext: [...input.inherited],
    // `maxDepth: 1` means "this node itself may run", and that is the whole of what
    // a node's own budget governs. Recursion is not a node's to spend — the arbiter
    // owns depth, and a node at the search's depth cap must still do its work
    // rather than being stopped before its first step, which is what a depth of 0
    // would do here (`budgetExhausted` treats it as exhausted).
    budget: nodeBudget,
    // The journal's own label column speaks the head vocabulary. A search settles
    // by `settleOf` and the run's report records that; this maps the one honest
    // case and takes the synthesis word for the rest, because the column is a label
    // and `ResolvedSwarm.settle` is the fact.
    mergeStrategy: input.settle === 'best' ? 'best_of' : 'synthesize',
  };

  deps.journal.insertSpawn(headInput);

  const spec: NodeRunSpec = {
    headInput,
    base: input.base,
    messages: input.messages,
    isolation: home.isolation,
    home: home.home,
    maxSteps: deps.maxSteps,
    canPropose: input.arbitrate !== null,
  };

  const run = deps.host === undefined
    ? await runNodeLoop(spec, nodeLoopDeps(input, deps))
    : await deps.host(spec, input.arbitrate);

  deps.journal.recordReport(run.report);
  deps.reportModelCall?.({ source: 'swarm', usage: run.report.usage });

  const read = readNodeReport({
    report: run.report,
    reported: run.reported,
    languages: deps.rt.executor.languages,
  });
  return {
    report: run.report,
    candidate: read.candidate,
    granted: run.granted,
    usage: run.report.usage,
    isolation: home.isolation,
    reportedItself: run.reported !== null,
    produced: run.produced,
  };
}

/**
 * The in-isolate seams: the search's own journal and arbiter, called directly.
 *
 * A host builds the same shape out of RPCs to the parent instead. Separated so
 * the two transports differ in this function alone.
 */
function nodeLoopDeps(input: NodeAgentInput, deps: NodeAgentDeps): NodeLoopDeps {
  const loop: NodeLoopDeps = {
    rt: deps.rt,
    model: deps.model,
    logger: deps.logger,
    arbitrate: input.arbitrate,
    reportStep: (seq, step) => { deps.journal.appendStep(input.nodeId, seq, step); },
  };
  if (deps.signal !== undefined) loop.signal = deps.signal;
  if (deps.mission !== undefined) loop.mission = deps.mission;
  if (deps.executeTool !== undefined) loop.executeTool = deps.executeTool;
  if (deps.webSearch !== undefined) loop.webSearch = deps.webSearch;
  return loop;
}
