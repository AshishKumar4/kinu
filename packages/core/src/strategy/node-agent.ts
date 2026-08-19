/**
 * ONE NODE OF A SWARM, AS AN AGENT.
 *
 * Specified by docs/EXPLORATION.md — "A node is an agent", "Node identity",
 * "Inherited context", "The report seam", "Arbitration", "Isolation" and "The
 * journal read model".
 *
 * A node used to be one `generateText` call whose whole output was text. It is an
 * AGENT now, normatively so, and *A node is an agent* lists the six things that
 * makes it one: a tool loop with a stop condition, a tool surface, no delegation
 * authority, its own model, its own transcript, and its own workspace. This module
 * is five of those six. The sixth is built: {@link nodeWorkspace} hands a node a
 * real home directory in the one global view, owned by the node's own uid,
 * provisioned by `agentHomeNodeProvisioner` in `strategy/node-workspace.ts`.
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
 * WHAT A NODE IS GRADED ON IS WHAT IT REPORTS, never what it changed. There are
 * exactly two isolation states and no third ({@link NodeWorkspace.isolation} says
 * which): a node has its own home, or it runs on a host with no credentialled
 * filesystem, where there is no boundary at all and every node changes the same
 * tree. In that second state a diff of the workspace attributes nothing, which is
 * why the grading signal is the report in both. The engine writes the REPORTED
 * candidate to the verifier's path and measures that, one node at a time. This is
 * the constraint the delegation doctrine used to state as the reason a graded node
 * could not hold tools at all; it is a constraint on the GRADING SIGNAL, not on the
 * tool surface, and separating the two is what made this commit possible.
 *
 * THE REPORT IS CONSUMED THROUGH ONE FUNCTION. *The grading report's retry bound,
 * its terminal set and its verifier immutability are not settled here*, so
 * {@link readNodeReport} is the whole boundary: it takes what a node's loop
 * produced and returns the candidate and the conclusion the engine needs. Today
 * that is the existing `report` tool's status-and-content shape plus the loop's own
 * final text. When the grading fields land, this one function changes and nothing
 * else does.
 */

import { jsonSchema, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { HEAD_BUILTIN_TOOLS, keepBuiltins } from '../heads/types';
import { HeadCapture, runHeadInference, withHeadCaptureRecording } from '../heads/head-inference';
import type { HeadInferenceDeps } from '../heads/head-inference';
import { buildBuiltinTools } from '../tools/builtins';
import type { BuiltinToolDeps } from '../tools/builtins';
import { AgentWakeQueue } from '../jobs/wake-queue';
import { BackgroundJobRunner } from '../jobs/runner';
import type { BackgroundJobRunnerDeps } from '../jobs/runner';
import { BackgroundJobStore, initBackgroundJobsTable } from '../jobs/store';
import { CONFINED_BACKGROUNDABLE_TOOLS, wrapToolsForBackground } from '../jobs/background-wrap';
import type { BackgroundPolicy } from '../jobs/threshold';
import { readProposalCode } from '../execution/code-fence';
import { nodeWorkspace, isolationDisclosure } from './node-workspace';
import { TURN_WALL_CLOCK_ENVELOPE_MS } from '../config';
import { BRANCH_PROPOSAL_WIDTH, SWARM_CONTEXTS } from './swarm';
import { renderCauseChain, toProteusError } from '../obs/error';
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
 * confined surfaces cannot drift — under *A node is an agent* a node's set is a
 * head's plus the report and the proposal, and the proposal is not a builtin.
 *
 * What a node does NOT get is stated in {@link NODE_WITHHELD_TOOLS}, with the
 * reason beside each name, and the two together are asserted to be the WHOLE
 * builtin surface — so a builtin added upstream tomorrow is a failing test rather
 * than a tool that silently appears on nodes or silently does not.
 */
export const NODE_BUILTIN_TOOLS = [...HEAD_BUILTIN_TOOLS, 'report'] as const;

/**
 * THE BUILTINS A NODE IS NOT GIVEN, AND WHY EACH ONE.
 *
 * A withheld capability with no argument behind it is not confinement, it is an
 * omission that nobody has re-examined. So every name here carries the property of
 * the code that justifies it, and the set is checked against the shipped builtin
 * surface: absent a reason, a tool goes in.
 *
 * Two of the three share one argument, and it is the grading contract this whole
 * search is built on: {@link nodeSystemPrompt} tells a node that *the search
 * compares what each of you REPORTS — not the state you leave behind*, and both
 * `memory` and `tasks` exist to durably store state nothing in the search reads.
 * Worse than ungraded, they are MISATTRIBUTED: both are unconditional on `rt`
 * alone and write to per-workspace tables, and a node that runs in this isolate
 * holds its parent's `rt` — so three siblings interleave into the one
 * `memory/MEMORY.md` and the one `agent_tasks` list, under the parent's name, in a
 * store the search grades nobody on. That also contradicts, in the same breath,
 * the isolation the node was just told it has: `isolationDisclosure` names the
 * plane a node shares and says it is not attributable to it, and a node under
 * `private-home` would reach straight through that boundary into the parent's SQL.
 */
export const NODE_WITHHELD_TOOLS = {
  // NOT "unbounded recursion" — that was checked and it is not the reason.
  // `DELEGATION_MAX_DEPTH` is 4 and already enforced, but it governs the SUBORDINATE
  // hire ladder through `TeamToolDeps.delegation`, which is a different axis from a
  // node's search-tree depth; and a node's depth is derived by the engine and known
  // before its tools are built, so a depth check was available either way.
  //
  // The two real reasons. STRUCTURAL: this tool's implementation IS the search
  // engine (`strategy/swarm-run` → `strategy/node-agent`), so a node's surface
  // holding it is a runtime import ring — the same ring whose module-scope reader
  // put six tests in a TDZ, which is why `builtins.ts` does not register it at all.
  // DOCTRINAL: a node's only route to more actors is `propose_branch`, which the
  // engine arbitrates against a shared budget the node cannot see, so `agents`
  // would let a node fund work outside the search's budget.
  agents: 'the delegation tool IS the search engine (an import ring), and a node funds '
    + 'more actors only through the arbiter, which holds the budget it cannot see',
  memory: 'durable notes, facts and past sessions live in per-workspace stores the node '
    + 'shares with its parent and its siblings; the search grades reports, not state left behind',
  tasks: 'one `agent_tasks` list per workspace, shared with the parent and every sibling, '
    + 'and its `mode` action writes the PARENT\'s stance into `agent_config`',
} as const satisfies Readonly<Record<string, string>>;

/** The node's own branch route. One name, so reading a transcript tells a human
 *  which tool asked for budget. */
export const PROPOSE_BRANCH_TOOL = 'propose_branch';

/**
 * HOW LONG ONE NODE MAY RUN, derived from the two bounds this repository already
 * measured and declared, and NOT a number of its own.
 *
 * WHY IT IS PER-STEP AND NOT PER-NODE. A node is many turns — one live swarm run of
 * three tool-using nodes on `@cf/deepseek-ai/deepseek-v4-pro-0813` recorded 22, 25 and
 * 26 model steps with 25, 27 and 27 tool calls — so giving a whole node ONE
 * {@link TURN_WALL_CLOCK_ENVELOPE_MS} is the same class of error as the 120_000 that
 * killed every MCTS rollout, only in the other direction: that run's nodes were still
 * working at 1,216,358 / 1,310,061 / 1,336,833 ms, each of which is past 600_000. The
 * unit that run DID measure is a step: 1,216,358 / 22 = 55,289 ms is the largest mean
 * step of the three, and every one of them is inside the turn envelope, which is
 * already this tree's ceiling for one model call inside a turn
 * ({@link DEFAULT_JUDGE_CALL_TIMEOUT_MS}). So the per-step term is the existing
 * constant, unchanged and re-measured rather than re-reasoned, and the node total
 * scales with the node's OWN step cap.
 *
 * WHY `maxSteps` IS THE MULTIPLIER. It is the bound the swarm already runs a node to —
 * `runSwarm` hands every node `deps.maxSteps ?? DEFAULT_MAX_STEPS`. A wall clock below
 * this product cuts a node that is inside its declared step budget, which is exactly
 * what happened: the run above was given 1_200_000 ms, and 1_200_000 is under
 * `nodeWallClockEnvelopeMs(26)` by a factor of 13. The two bounds were in different
 * units and had never been reconciled, so the clock was measuring the step cap's
 * shadow. `unit-swarm-node-envelope.test.ts` holds this equality and the measured
 * floor together, so moving either bound fails a test rather than drifting.
 *
 * WHAT IT DOES NOT DO. It is observed at STEP BOUNDARIES only — `runHeadInference`'s
 * `stopWhen` asks `budgetExhausted` between steps — because a cooperative deadline
 * cannot pre-empt synchronous work, and a node inside one long step observes nothing.
 * That residue is documented rather than papered over; the binding bound on a node's
 * work remains its step cap.
 *
 * PENDING MEASUREMENT: how many steps a node needs to FINISH on this model. No node in
 * the run above ever did, so 26 is a floor on the demand and nothing here is entitled
 * to a step cap below `DEFAULT_MAX_STEPS`. Owed: one run whose nodes are allowed to
 * complete.
 */
export function nodeWallClockEnvelopeMs(maxSteps: number): number {
  return maxSteps * TURN_WALL_CLOCK_ENVELOPE_MS;
}


/** What the engine hands one node before it runs. Identity and depth come from the
 *  engine's own row — a node states neither, per *Node identity* — and the seed is
 *  assembled by the engine because *Inherited context* makes the seed the engine's
 *  to author, never the parent's. */
export interface NodeAgentInput extends NodeIdentity {
  readonly parentId: string | null;
  /** The pinned task block, verbatim at every depth (*Inherited context*). Also the
   *  journal's own record of what this node was asked. */
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
   * NULL MEANS THE TOOL IS ABSENT, not present-and-refusing. That is *Build-time
   * exclusion*, which `head-tools.ts` already applies to `split_subheads`: a request
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
   * inherited — the append-only rule of *Inherited context*, which is a decision
   * about caching: the prefix every sibling shares is byte-identical, so a provider
   * can cache it once for the whole level.
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
  /** Where the node's transcript lands. Under *The journal read model* a transcript
   *  is a read model over the node's journal, never a second store. */
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
  /**
   * THE DEADLINE THIS NODE RUNS TO, observed between its own steps.
   *
   * REQUIRED, unlike every other bound-shaped dep here, and that is the fix rather
   * than a style choice: it was optional, no caller ever set it, and an absent key
   * left `stopWhen`'s `budgetExhausted` nothing to check — so the search's own abort
   * signal was a node's only clock, and that signal cuts an entire WAVE at once. A
   * type that permits no deadline permits that defect again. Callers derive the value
   * from {@link nodeWallClockEnvelopeMs} and may declare a tighter one.
   */
  maxWallClockMs: number;
  /** Stream-inactivity watchdog override, in ms. Passed straight through to the turn
   *  loop; see {@link NodeLoopDeps.stallTimeoutMs}. */
  stallTimeoutMs?: number;
  /** Detach policy override for a node's tools; see
   *  {@link NodeLoopDeps.backgroundPolicy}. */
  backgroundPolicy?: () => BackgroundPolicy;
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
  /** Stream-inactivity watchdog override, in ms — the turn loop's own bound, whose
   *  default is five minutes and therefore untestable in a suite that has to finish. */
  stallTimeoutMs?: number;
  /**
   * The detach policy a node's tools run to. Defaults to
   * `BACKGROUND_POLICY.interactive`, which is the right one: a node is a place a wake
   * can arrive, and that is exactly what `wakesAfterTurn` names.
   *
   * Declared for the reason {@link NodeLoopDeps.stallTimeoutMs} is, and for one more: a
   * threshold whose only value is 30 s cannot be exercised by a test that has to
   * finish, so the arm proving a node's turn ENDS with work still running would take
   * half a minute per assertion. What a caller overrides is the MAGNITUDE.
   */
  backgroundPolicy?: () => BackgroundPolicy;
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
 * The proposal tool — *Arbitration* expressed as a tool, so the verdict is a RETURN
 * VALUE.
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
  readonly jobRunner: BackgroundJobRunner;
  readonly mode: WorkMode;
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
  // THE BACKGROUND WRAP, inside the capture and not outside it. A call that crosses
  // the detach threshold returns a handle rather than a result, and the handle is
  // what the model was TOLD — so the transcript has to record that, not a result
  // the model never saw. The confined set is named here for the reason
  // `keepBuiltins` takes a named set: a node has no `agents` tool, so the actor's
  // third entry cannot apply to it, and naming the set makes that structural.
  const detachable = wrapToolsForBackground(surface, {
    jobRunner: input.jobRunner,
    backgroundable: CONFINED_BACKGROUNDABLE_TOOLS,
    mode: () => input.mode,
  });
  return withHeadCaptureRecording(detachable, input.capture);
}

/**
 * THE REPORT SEAM. Everything the engine takes out of a finished node passes
 * through here.
 *
 * The grading mechanism is still being decided — *The grading report's retry bound,
 * its terminal set and its verifier immutability are not settled here*, and neither
 * is whether merge-back refuses a transaction — so this consumes the report at the
 * shape that exists today and nothing further: the node's own `report` call when it
 * made one, and the loop's final text otherwise. It computes NO score. *No
 * self-grading* is why: a node does not grade itself, so the quantity a node would
 * have to lie about is one it never supplies.
 *
 * The fence is read for the same reason the toolless path reads it: a candidate that
 * arrives inside a code fence is code, and the instrument runs code. A fence in a
 * language the executor cannot run is kept WHOLE rather than dropped, because it is
 * still the node's answer and the measurement will say so with the instrument's own
 * reason.
 */
/** What the engine takes out of a finished node: the candidate the instrument measures,
 *  and the conclusion a child's seed carries. No score — *No self-grading*: a node
 *  does not grade itself, so the quantity it would have to lie about is one it
 *  never supplies. */
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
 * IT IS A PLACE A WAKE CAN ARRIVE, and that is what makes a node an actor rather
 * than a special case. `BACKGROUND_POLICY.interactive` detaches work that crosses
 * 30 s wherever `wakesAfterTurn` holds, and the rule is that where a wake can
 * arrive it detaches — so a node gets the same {@link BackgroundJobRunner} an
 * actor has, its tool surface threads it, and a TURN MAY END WITH WORK STILL
 * RUNNING. The node then takes another turn when the result lands. The runner's
 * default policy is the interactive one, which is the correct one here and is why
 * nothing declares it.
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
  // The node's wake path: the in-process counterpart of the actor's durable
  // message queue, behind the SAME `SignalDeliverer` seam, so the runner neither
  // knows nor can tell which kind of agent it is settling a job for.
  const wakes = new AgentWakeQueue();
  // The table is reconciled here rather than assumed: this loop runs in the
  // search's isolate OR in a facet with storage of its own, and only one of those
  // has already opened a workspace.
  initBackgroundJobsTable(deps.rt.storage.execRaw, deps.rt.storage.sql);
  const runnerDeps: BackgroundJobRunnerDeps = {
    store: new BackgroundJobStore(deps.rt.storage.sql),
    fiber: deps.rt.schedule.fiber,
    signals: wakes,
    logActivity: (event, detail) => {
      deps.logger.event('swarm.node_job', {
        nodeId: spec.headInput.id, job: event, detail: detail ?? '',
      });
    },
    // No `eventLog`/`scheduleDrain`: a node is abandoned with the run that spawned
    // it, so a durable breadcrumb for a later activation would be delivered to a
    // node that no longer exists — and the queue above cannot fail to deliver, so
    // there is nothing to compensate. No `resume` for the same reason.
  };
  // Assigned rather than spread: an absent policy must be an ABSENT KEY, because the
  // runner reads presence to decide whether to fall back to the interactive default.
  if (deps.backgroundPolicy !== undefined) runnerDeps.policy = deps.backgroundPolicy;
  const jobRunner = new BackgroundJobRunner(runnerDeps);
  // The arbiter is offered only when the search said a branch could be granted.
  // Both halves are required: a host's arbiter is an RPC stub and therefore
  // always non-null, so presence alone cannot answer whether to offer the tool.
  const tools = buildNodeToolSet({
    deps,
    capture,
    scratch,
    arbitrate: spec.canPropose ? deps.arbitrate : null,
    jobRunner,
    mode: spec.headInput.mode,
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
    // WHAT MAKES A TURN THAT DID NOT REPORT A NORMAL OUTCOME. A node that has
    // reported is finished — that is its whole terminal condition. A node that has
    // not is finished only when it is holding nothing: no job of its own still
    // running, and no wake already queued. Otherwise it waits, and the wake it
    // waits for is its next turn's last message.
    resume: async () => {
      if (scratch.reported !== null) return null;
      return wakes.next(() => jobRunner.inFlight > 0);
    },
  };
  // Assigned rather than spread: an absent seam must be an ABSENT KEY, because
  // `runHeadInference` reads presence to decide whether the behaviour exists.
  if (deps.mission !== undefined) inference.mission = deps.mission;
  if (deps.reportStep !== undefined) inference.reportStep = deps.reportStep;
  if (deps.signal !== undefined) inference.signal = deps.signal;
  if (deps.stallTimeoutMs !== undefined) inference.stallTimeoutMs = deps.stallTimeoutMs;

  try {
    const report = await runHeadInference(spec.headInput, inference);
    return {
      report,
      reported: scratch.reported,
      granted: scratch.granted,
      produced: scratch.produced,
    };
  } finally {
    // A node reaches here holding work only when it REPORTED while a job was still
    // running, or when the search cut it. Either way the result has no reader left,
    // so the live process tree is cancelled rather than left running past the agent
    // that launched it. Scoped to this runner, so a sibling's jobs are untouched.
    jobRunner.cancelRunning();
  }
}

/**
 * Run one node as an agent, and journal it.
 *
 * THE LOOP's failures are reports: {@link runHeadInference} turns a provider error
 * into an `errored` report, and a node that errored is a candidate the search could
 * not measure rather than a run that stops.
 *
 * THE TRANSPORT's failures are not, and this function used to claim otherwise. A
 * {@link NodeAgentDeps.host} is an RPC to another Durable Object; a rejection there
 * arrives as a thrown error with no report behind it, and there is no report for the
 * ledger to record. So this DOES throw for that case — wrapped, with the cause
 * chained — and it journals the node terminal FIRST, because `insertSpawn` below has
 * already published the row as `running` and `running` means exactly "spawned, and no
 * report recorded". A throw past that write leaves a row that reads as a node still
 * working for the life of the store, which is the absent-versus-broken confusion in
 * its worst form: the engine counted one fewer candidate while the journal said the
 * node was mid-flight.
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
  // (`budgetExhausted` treats it as exhausted).
  //
  // THE DEADLINE IS ALWAYS PRESENT, and the caller resolved it: one `??` for a node's
  // clock in the whole tree, so a caller and this function cannot end up disagreeing
  // about what it is. It used to be an absent key, and then `stopWhen`'s
  // `budgetExhausted` had nothing to check and the run's abort signal was a node's only
  // clock — a run-level bound that cuts an entire wave mid-step.
  const nodeBudget: HeadBudget = {
    maxDepth: 1,
    spawnedAt: Date.now(),
    maxWallClockMs: deps.maxWallClockMs,
  };

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

  // THE TERMINAL WRITE IS OWED BY WHOEVER OPENED THE ROW, and this is the only place
  // that holds both the open row and the transport. Rethrown rather than turned into a
  // report: the search counts a node it could not measure as one fewer candidate, and
  // that is a different claim from a node that ran and reported nothing.
  let run: NodeLoopResult;
  try {
    run = deps.host === undefined
      ? await runNodeLoop(spec, nodeLoopDeps(input, deps))
      : await deps.host(spec, input.arbitrate);
  } catch (cause) {
    const failure = toProteusError({
      doing: `run node ${input.nodeId} of this search`, cause, otherwise: 'unavailable',
    });
    const chain = renderCauseChain(failure);
    deps.journal.recordReport({
      id: input.nodeId,
      status: 'errored',
      summary: `Node ${input.nodeId} produced no report: ${chain}`,
      evidence: [], decisions: [], artifactRefs: [], fileChanges: [], childHeadIds: [],
      toolCalls: [],
      // ZERO AND `{}` ARE READINGS, not defaults. No report came back, so nothing here
      // can say what the node spent; `recordReport` stores an absent usage field as
      // NULL, which keeps "the provider never reported" distinguishable from "reported
      // zero". Whatever steps the node did manage are already in `head_steps` under its
      // own id, which is the progress record either way.
      stepCount: 0,
      usage: {},
      wallClockMs: Date.now() - nodeBudget.spawnedAt,
      errorMessage: chain,
    });
    throw failure;
  }

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
  if (deps.stallTimeoutMs !== undefined) loop.stallTimeoutMs = deps.stallTimeoutMs;
  if (deps.backgroundPolicy !== undefined) loop.backgroundPolicy = deps.backgroundPolicy;
  return loop;
}
