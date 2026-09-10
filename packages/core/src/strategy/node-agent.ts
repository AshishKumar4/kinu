/**
 * ONE NODE OF A SWARM, AS AN AGENT.
 *
 * Specified by docs/EXPLORATION.md — "A node is an agent", "Node identity",
 * "Inherited context", "The report contract", "Arbitration", "Isolation" and "The
 * journal read model".
 *
 * A node is an AGENT, normatively so, and *A node is an agent* lists the six things that
 * makes it one: a tool loop with a stop condition, a tool surface, no delegation
 * authority, its own model, its own transcript, and its own workspace. This module
 * is five of those six. The sixth is built: {@link nodeWorkspace} hands a node a
 * real home directory in the one global view, owned by the node's own uid,
 * provisioned by the backend's `provisionNodeHome` seam over
 * `facetHomeProvisioner`, keyed on the node actor's storage key.
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
 * the constraint the delegation doctrine states, and it is a constraint on the GRADING
 * SIGNAL, not on the tool surface: a graded node holds tools, and what grades it is
 * still the report.
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
import { HEAD_BUILTIN_TOOLS } from '../heads/types';
import { HeadCapture, runHeadInference, withHeadCaptureRecording } from '../heads/head-inference';
import type { PublishHeadStream, ReportHeadDelta } from '../heads/head-stream';
import type { HeadInferenceDeps } from '../heads/head-inference';
import type { HostedActor } from '../state/actor-host';
import type { ProfileAuthorityInputs, ResolvedTurnProfile } from '../profiles';
import type { DynamicContext } from '../prompting/volatile-context';
import { buildToolSurface, type ReportToolDeps } from '../tools/builtins';
import { AgentWakeQueue } from '../jobs/wake-queue';
import { permitInPlan } from '../execution/work-mode';
import { BackgroundJobRunner } from '../jobs/runner';
import type { BackgroundJobRunnerDeps } from '../jobs/runner';
import { initBackgroundJobsTable } from '../jobs/store';
import { CONFINED_BACKGROUNDABLE_TOOLS, wrapToolsForBackground } from '../jobs/background-wrap';
import type { BackgroundPolicy } from '../jobs/threshold';
import { readProposalCode } from '../execution/code-fence';
import type { JsonValue } from '../utils/json';
import { nodeWorkspace, isolationDisclosure } from './node-workspace';
import { BRANCH_PROPOSAL_WIDTH, SWARM_CONTEXTS } from './swarm';
import { renderCauseChain, toKinuError } from '../obs/error';
import { abortCause } from '../utils/abort';
import type { Logger } from '../obs/index';
import type { Usage } from '../usage';
import type { BranchContext, SwarmSettle } from './swarm';
import type { BranchDecision } from './swarm-budget';
import type {
  NodeIdentity, NodeIsolation, NodeWorkspace, NodeWorkspaceProvisioner,
} from './node-workspace';
import type {
  CapturedReport, NodeArbiter, NodeLoopResult, NodeRunSpec,
} from './node-host';

export type {
  CapturedReport, NodeArbiter, NodeLoopResult, NodeRunSpec,
} from './node-host';

import type { HeadBudget, HeadInput, HeadReport, HeadStep, SerializedMessage } from '../heads/types';
import type { HeadJournal } from '../heads/journal';
import type { MissionScope } from '../mission-budget';
import type { AgentRuntime } from '../types/agent-runtime';
import type { WebSearchProvider } from '../web/index';
import type { WorkMode } from '../types/turn';
import type { ModelCallSink } from '../events/model-call';
import type { BuiltinToolName } from '../tools/registry';
import { defaultLoopOrigin } from '../scaffold/loop-origin';

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
export const NODE_BUILTIN_TOOLS = [...HEAD_BUILTIN_TOOLS, 'report'] as const satisfies readonly BuiltinToolName[];

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
  memory: 'durable notes, facts and the past conversation live in per-workspace stores the node '
    + 'shares with its parent and siblings; search grades reports, not state left behind',
  tasks: 'one `agent_tasks` list per workspace, shared with the parent and siblings; '
    + 'its `mode` action selects the parent agent’s durable role',
} as const satisfies Readonly<Record<string, string>>;

/** The node's own branch route. One name, so reading a transcript tells a human
 *  which tool asked for budget. */
export const PROPOSE_BRANCH_TOOL = 'propose_branch';


/** What the engine hands one node before it runs. Identity and depth come from the
 *  engine's own row — a node states neither, per *Node identity* — and the seed is
 *  assembled by the engine because *Inherited context* makes the seed the engine's
 *  to author, never the parent's. */
export interface NodeAgentInput extends NodeIdentity {
  readonly parentId: string | null;
  /** The node's assigned question, preserved in its journal row. */
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
   * The model SPEC this node's slot was assigned, where the call routed per node
   * (`SwarmInput.models`). The engine resolves the same spec to the live model an
   * in-isolate run uses; this string is the HOSTED half — it lands on
   * `HeadInput.model` so a facet can resolve it through its own owner registry.
   * Absent on an unrouted run.
   */
  readonly modelSpec?: string | undefined;
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
   * What a `context:'inherit'` child inherits, appended to what this node itself
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
  /**
   * Acquire the hosted logical actor ONE node runs as, by that node's identity.
   *
   * A FACTORY, and it has to be: a search builds these deps once and shallow
   * copies them per child, so a single `HostedActor` here would give every node
   * of a wave one claim ledger, one loop pointer and one set of rows — the exact
   * cross-actor collision this factory makes impossible. One call per node, one
   * actor per node, all of them over the same database.
   */
  hostNode: (node: NodeIdentity) => Promise<HostedNodeSeat>;
  model: LanguageModel;
  /** Where the node's transcript lands. Under *The journal read model* a transcript
   *  is a read model over the node's journal, never a second store. */
  journal: HeadJournal;
  logger: Logger;
  signal?: AbortSignal;
  reportModelCall?: ModelCallSink;
  publishHeadStream?: PublishHeadStream;
  mission?: MissionScope;
  /** The node's home provisioner. Absent is a host with no uid-0 view, and then
   *  the shared plane is REPORTED — see {@link nodeWorkspace}. */
  provisionHome?: NodeWorkspaceProvisioner;
  /**
   * The runtime a node's loop uses once its home exists — the SAME workspace,
   * addressed as the node.
   *
   * Here rather than derived, because only the backend can rebuild the live
   * primitives a credential changes: a shell that runs commands as the node's
   * uid and a file plane that acts as it, over the filesystem it already holds.
   * Core has the credential and no way to make either from it.
   *
   * Absent leaves {@link actor}'s own runtime in place, which is the honest
   * state for a runtime with no provisioner at all: the node reports
   * `shared-origin-plane` and runs exactly as the origin.
   */
  runtimeForWorkspace?: (workspace: NodeWorkspace, identity: NodeIdentity) => Promise<AgentRuntime>;
  /** Backend-built `execute_tools`; absent on a runtime that wired none, and then
   *  the tool is absent too rather than broken. */
  executeTool?: unknown;
  webSearch?: WebSearchProvider;
  /** The report contract's gate; see {@link NodeLoopDeps.gradeReport}. */
  gradeReport?: (candidate: string) => Promise<string | null>;
  /**
   * A CALLER-DECLARED deadline for this node, observed between its own steps.
   *
   * OPTIONAL — and that is the ruling, not an oversight: there is no default
   * wall clock over a node's work. Absent, a node runs until its work is done,
   * the caller cancels it, a provider or tool fails definitively, or its mission
   * budget refuses the next step. Present, the search or a test declared a
   * tighter deadline, which `runHeadInference` honours at step boundaries.
   */
  maxWallClockMs?: number;
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
/**
 * One node's own actor and the per-turn seams that belong to it.
 *
 * Returned by {@link NodeAgentDeps.hostNode} rather than assembled by the
 * search, because every member of it is per ACTOR: the session that admits the
 * claims, the run the claims are attributed to, the role narrowing that turn
 * resolves under, and the live block that turn renders.
 */
export interface HostedNodeSeat {
  readonly actor: HostedActor;
  /** The activation's run id; every turn this node admits is claimed under it. */
  readonly runId: string;
  /** How this node's turn is profiled — the same role and tier narrowing an
   *  actor's chat turn resolves. Role restrictions apply to every full kind. */
  readonly profile: (input: { readonly availableTools: readonly string[]; readonly workMode: WorkMode })
    => Promise<{ readonly profile: ResolvedTurnProfile; readonly inputs: ProfileAuthorityInputs }>;
  /** This node's own live per-step block (its jobs, tasks, approvals). */
  readonly dynamic: () => DynamicContext;
}

export interface NodeLoopDeps {
  /**
   * The HOSTED logical actor this node IS — its handle, its actor-scoped stores
   * over the ONE workspace database, its runtime and its session.
   *
   * A `HostedActor` and not a bare `rt`, because a node's turn writes a durable claim:
   * the kind whose whole job is to explore under the workspace's own program runs under
   * an identity, on the workspace's own database, with a claimed loop. Its runtime is
   * `actor.runtime`; its turns are claimed turns on `actor.session`.
   */
  actor: HostedActor;
  /** The activation's run id; every turn this node admits is claimed under it. */
  runId: string;
  /** How this node's turn is profiled — the same role and tier narrowing an
   *  actor's chat turn resolves. Role restrictions apply to every full kind. */
  profile: (input: { readonly availableTools: readonly string[]; readonly workMode: WorkMode })
    => Promise<{ readonly profile: ResolvedTurnProfile; readonly inputs: ProfileAuthorityInputs }>;
  /** This node's own live per-step block (its jobs, tasks, approvals). */
  dynamic: () => DynamicContext;
  model: LanguageModel;
  logger: Logger;
  signal?: AbortSignal;
  mission?: MissionScope;
  /** Where each finished step lands WHILE the node still runs. */
  reportStep?: (seq: number, step: HeadStep) => Promise<void> | void;
  /** Where the node's output goes WHILE a step is still being produced —
   *  transient frames, superseded by `reportStep`'s row (heads/head-stream.ts). */
  reportDelta?: ReportHeadDelta;
  /** The search's arbiter, or null when no branch could be granted. */
  arbitrate: NodeArbiter | null;
  executeTool?: unknown;
  webSearch?: WebSearchProvider;
  /**
   * THE REPORT CONTRACT'S GATE: run the objective's instrument over what the node is
   * about to report, and answer with the instrument's errors instead of accepting it.
   *
   * Returns null to let the report land, or the text the node reads as its next
   * instruction. ABSENT where the run has no instrument — a judged run has nothing to
   * gate on — and absent rather than a function that always accepts, because a check
   * that passed and a check that never existed are different facts.
   *
   * IT DECIDES WHETHER THE INSTRUMENT RAN, NOT WHETHER THE ANSWER IS GOOD. A node that
   * reports something the instrument measures at a poor value passes this and is scored
   * low; a node whose answer the instrument cannot run at all is turned back with the
   * reason. Grading stays with the engine — *No self-grading* — so the quantity a node
   * would have to lie about is still one it never supplies.
   *
   * NOTHING BOUNDS THE RETRIES HERE and nothing should. The node's own step budget is
   * already the bound: a node that cannot satisfy the instrument runs out of steps and
   * ends unreported, which the search reads as a member that produced nothing. A retry
   * count declared here would be a second bound with no measurement behind it.
   */
  gradeReport?: (candidate: string) => Promise<string | null>;
  /**
   * The detach policy a node's tools run to. Defaults to
   * `BACKGROUND_POLICY.interactive`, which is the right one: a node is a place a wake
   * can arrive, and that is exactly what `wakesAfterTurn` names.
   *
   * Declared because a threshold whose only value is 30 s cannot be exercised by a
   * test that has to finish, so the arm proving a node's turn ENDS with work still
   * running would take half a minute per assertion. What a caller overrides is
   * the magnitude.
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
  proposal: Promise<BranchDecision> | null;
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
    [PROPOSE_BRANCH_TOOL]: permitInPlan(tool({
      description:
        `Ask the search to spend part of its budget exploring ${String(BRANCH_PROPOSAL_WIDTH.min)}-`
        + `${String(BRANCH_PROPOSAL_WIDTH.max)} narrower threads of your task. You are PROPOSING, `
        + 'not spawning: the search decides against a depth cap and a shared budget you cannot see, '
        + 'and this call returns either the children it reserved or the reason it refused. Each '
        + 'branch names what it starts from — "inherit" gives it your whole conversation, "fresh" gives '
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
        // ONCE PER NODE, enforced here and not left to the docstring. The engine
        // reads only the LAST grant, so a second arbitrate would debit the shared
        // budget again and strand the first grant's width — children paid for and
        // never created. Refusing BEFORE the arbiter runs keeps the first grant
        // the only one and the debit the only one.
        const priorAttempt = scratch.proposal;

        if (priorAttempt !== null) {
          const prior = await priorAttempt;

          if (prior.kind === 'granted') {
            return `Refused (already granted): ${String(prior.width)} children were reserved `
              + `(${prior.nodeIds.join(', ')}) when you proposed earlier. Finish and report — `
              + 'they are created from your report, so put in it what they will need.';
          }

          return `Refused (already proposed; ${prior.policy}): ${prior.error}`;
        }

        // The band is enforced by the arbiter and not by this schema, for
        // `BRANCH_PROPOSAL_WIDTH`'s own reason: an out-of-range request must
        // produce a reason-coded refusal the node can act on rather than being
        // unrepresentable and therefore unexplainable. `minItems`/`maxItems` are a
        // hint to the provider, and the AI SDK does not validate a `jsonSchema`
        // tool input at all.
        const attempt = Promise.resolve(arbitrate({
          rationale,
          branches: branches.map((branch) => ({
            task: branch.task,
            rationale: branch.rationale,
            // An absent `context` NARROWS. A node that did not say what its child
            // starts from has not asked for the parent's whole conversation.
            context: branch.context ?? 'fresh',
          })),
        }));

        // Reserved before the first await: AI SDK executes same-step tool calls
        // concurrently, so both calls must observe one shared arbitration.
        scratch.proposal = attempt;
        const decision = await attempt;

        if (decision.kind === 'refused') {
          return `Refused (${decision.policy}): ${decision.error}`;
        }

        scratch.granted = decision;

        return `Granted: ${String(decision.width)} children reserved (${decision.nodeIds.join(', ')}). `
          + 'They are created when you finish and report, and they receive your report as their seed, '
          + 'so put in it what they will need.';
      },
    })),
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

  // NAMED and ANNOTATED rather than written inline below, because this is the
  // one destination in the tree that declares `bodyOnly`: an unannotated
  // nested literal is a construction site nothing can attribute, and a field
  // supplied only there reads as supplied nowhere.
  const report: ReportToolDeps = {
    // THE PROSE BODY IS THE WHOLE OF WHAT THIS DESTINATION READS. A node is
    // measured on the candidate `candidateOf` extracts from `content`; there
    // is no parent conversation here to weigh a concern and no journal field
    // to keep one in. Declaring the handoff fields anyway would offer the
    // node four slots whose contents reach nobody.
    bodyOnly: true,
    report: async ({ status, content }): Promise<JsonValue> => {
      // THE INSTRUMENT RUNS HERE, BEFORE THE REPORT LANDS. The candidate is read out
      // of the content through {@link candidateOf} — the same function the engine
      // reads it with at the barrier, so the text the gate measures and the text the
      // search measures cannot be two different things.
      const errors = await deps.gradeReport?.(
        candidateOf(content.trim(), deps.actor.runtime.executor.languages),
      );

      if (errors !== undefined && errors !== null) {
        // NOT WRITTEN TO `scratch.reported`, which is the whole of "blocks": the
        // loop's terminal condition is a report having landed, so a refused one
        // leaves the node running with the instrument's own words as its next
        // instruction. Returned rather than thrown — a tool's refusal is its return
        // value, the same shape the proposal tool answers an arbiter's denial with.
        return { accepted: false, errors };
      }

      scratch.reported = { status, content };

      return { received: true };
    },
  };

  // The proposal merges after the finish, so the sandbox never declares it;
  // the background wrap runs inside the capture, so the transcript records
  // the handle the model was told rather than a result it never saw.
  return buildToolSurface({
    rt: deps.actor.runtime,
    workMode: input.mode,
    logger: deps.logger,
    report,
    webSearch: deps.webSearch,
    admitted: NODE_BUILTIN_TOOLS,
    executeTool: deps.executeTool,
    post: input.arbitrate ? buildProposeTool(input.arbitrate, scratch) : undefined,
    wrapFinished: (finished) => withHeadCaptureRecording(
      wrapToolsForBackground(finished, {
        jobRunner: input.jobRunner,
        backgroundable: CONFINED_BACKGROUNDABLE_TOOLS,
        mode: () => input.mode,
      }),
      input.capture,
    ),
  });
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

/**
 * The text an instrument is pointed at, from what a node wrote.
 *
 * ONE definition with two callers, and the second one is why it exists: the report
 * contract's gate measures a candidate BEFORE the report lands, and the engine measures
 * one AFTER. Two spellings of this extraction would let the gate accept an answer the
 * barrier then measured differently, which is a node told its work passed and a search
 * scoring something else.
 */
function candidateOf(
  conclusion: string, languages: readonly [string, ...string[]],
): string {
  const code = readProposalCode(conclusion, languages);

  return code?.kind === 'runnable' ? code.code : conclusion;
}

export function readNodeReport(input: {
  readonly report: HeadReport;
  readonly reported: CapturedReport | null;
  readonly languages: readonly [string, ...string[]];
}): NodeReport {
  const conclusion = input.reported?.content.trim() || input.report.summary.trim();

  return { candidate: candidateOf(conclusion, input.languages), conclusion };
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
 * MODULE-PRIVATE, and reached only through {@link runNodeAgent}. It was exported
 * while a Cloudflare `SubordinateAgent` facet in node mode received a
 * {@link NodeRunSpec} as data, rebuilt the live seams against its own runtime and
 * called exactly this function. That facet is gone — `exploration-hosting.ts`
 * records why, and a node is a logical actor of the one workspace now — so the
 * second transport has no far side left and nothing outside this module calls
 * this. It stays ONE body with one caller, which is what the two-transport
 * arrangement was protecting in the first place.
 *
 * IT IS A PLACE A WAKE CAN ARRIVE, and that is what makes a node an actor rather
 * than a special case. `BACKGROUND_POLICY.interactive` detaches work that crosses
 * 30 s wherever `wakesAfterTurn` holds, and the rule is that where a wake can
 * arrive it detaches — so a node gets the same {@link BackgroundJobRunner} an
 * actor has, its tool surface threads it, and a TURN MAY END WITH WORK STILL
 * RUNNING. The node then takes another turn when the result lands. The runner's
 * default policy is the interactive one, which is the correct one here and is why
 *
 * It journals NOTHING. The ledger belongs to the search, and a loop that wrote to
 * its own copy would be the second store the journal rule forbids.
 */
async function runNodeLoop(
  spec: NodeRunSpec,
  deps: NodeLoopDeps,
): Promise<NodeLoopResult> {
  const capture = new HeadCapture();

  const scratch: NodeScratch = {
    reported: null,
    granted: null,
    proposal: null,
    produced: [],
  };

  // The node's wake path: the in-process counterpart of the actor's durable
  // message queue, behind the SAME `SignalDeliverer` seam, so the runner neither
  // knows nor can tell which kind of agent it is settling a job for.
  const wakes = new AgentWakeQueue();
  // The table is reconciled here rather than assumed: a node is its own logical
  // actor of the workspace, acquired per run, and nothing says its database has
  // already been opened for jobs by whoever ran before it.
  initBackgroundJobsTable(deps.actor.runtime.storage.execRaw);

  const runnerDeps: BackgroundJobRunnerDeps = {
    store: deps.actor.stores.jobs,
    fiber: deps.actor.runtime.schedule.fiber,
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

  // ONE SPELLING for "a branch could be granted here": a null arbiter. A second
  // spelling of the same fact on the spec — a `canPropose` flag beside it — could only
  // ever disagree with the arbiter by bug, and the arbiter is what the grant path
  // reads.
  const tools = buildNodeToolSet({
    deps,
    capture,
    scratch,
    arbitrate: deps.arbitrate,
    jobRunner,
    mode: spec.headInput.mode,
  });

  const inference: HeadInferenceDeps = {
    actor: deps.actor,
    runId: deps.runId,
    profile: deps.profile,
    dynamic: deps.dynamic,
    model: deps.model,
    tools,
    // The layout the node is TOLD matches the boundary it actually got, and the
    // prompt says the same thing in its own words through `isolationDisclosure`,
    // so the two cannot disagree.
    workspaceLayout: spec.isolation === 'private-home' ? 'private-scratch' : 'shared-workspace',
    capture,
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

  if (deps.reportDelta !== undefined) inference.reportDelta = deps.reportDelta;

  if (deps.signal !== undefined) inference.signal = deps.signal;

  try {
    const report = await runHeadInference(spec.headInput, inference);

    return {
      report,
      reported: scratch.reported,
      granted: scratch.granted,
      produced: scratch.produced,
      languages: deps.actor.runtime.executor.languages,
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
 * THE TRANSPORT's failures are NOT reports, and must not be turned into one. The
 * node's actor and the home-credentialed runtime are both acquired here; a failure
 * to build either arrives as a thrown error with no report behind it, and there is
 * no report for the ledger to record. So this DOES throw for that case — wrapped,
 * with the cause chained — and it journals the node terminal FIRST, because
 * `insertSpawn` below has already published the row as `running` and `running`
 * means exactly "spawned, and no report recorded". A throw past that write leaves a
 * row that reads as a node still working for the life of the store, which is the
 * absent-versus-broken confusion in its worst form: the engine counted one fewer
 * candidate while the journal said the node was mid-flight.
 *
 * This function owns everything the loop must not: the home, the ledger and the
 * node's own runtime. The loop owns the inference and nothing else.
 */
export async function runNodeAgent(
  input: NodeAgentInput,
  deps: NodeAgentDeps,
): Promise<NodeRun> {
  const home = await nodeWorkspace(
    { nodeId: input.nodeId, rootId: input.rootId, depth: input.depth },
    deps.provisionHome,
  );

  // The swarm owns recursion. This node has no independent split budget.
  const nodeBudget: HeadBudget = {
    maxDepth: 0,
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
    budget: nodeBudget,
    // The journal's own label column speaks the head vocabulary. A search settles
    // by `settleOf` and the run's report records that; this maps the one honest
    // case and takes the synthesis word for the rest, because the column is a label
    // and `ResolvedSwarm.settle` is the fact.
    mergeStrategy: input.settle === 'best' ? 'best_of' : 'synthesize',
    // A search explores under the loop it is searching FOR: a node reasoning
    // with the bootstrap loop while its parent runs a promoted one measures the
    // wrong program, so a node states its pointer rather than inheriting one.
    loop: defaultLoopOrigin('head'),
  };

  // THE LEDGER AND THE ROUTE THIS NODE WAS ASSIGNED, on the two fields of
  // `HeadInput` that already carry them. A node's own loop reads neither — its
  // ledger is the live `NodeLoopDeps.mission` port and its model is the resolved
  // one this run was handed — so these are the ROW's version of both facts, in
  // the one vocabulary every head-shaped input uses (a head resolved out of
  // process is bound from exactly these: `cli-backend/head-runtime.ts` reads
  // `input.model` and `input.missionLabels`). Assigned rather than declared above,
  // so an unbudgeted or unrouted run carries no key at all rather than a key
  // holding `undefined` — "charges nothing" and "charges an unnamed ledger" are
  // different claims.
  if (deps.mission) Object.assign(headInput, { missionLabels: deps.mission.labels });

  if (input.modelSpec !== undefined) Object.assign(headInput, { model: input.modelSpec });

  deps.journal.insertSpawn(headInput);

  const spec: NodeRunSpec = {
    headInput,
    base: input.base,
    messages: input.messages,
    isolation: home.isolation,
    home: home.home,
  };

  // THE TERMINAL WRITE IS OWED BY WHOEVER OPENED THE ROW, and this is the only place
  // that holds both the open row and the things a node's run needs before it can
  // start. A failure to build one of those is rethrown rather than turned into a
  // report: the search counts a node it could not measure as one fewer candidate,
  // and that is a different claim from a node that ran and reported nothing.
  // THE NODE'S ACTOR IS ONE OF THEM, so it is acquired here and a failure to
  // acquire it is rethrown. Binding runtime objects over the workspace's one
  // database is not the node's work; it is what has to exist before the node can do
  // any. The home-credentialed RUNTIME stays inside the try below, because that one
  // can fail for reasons that are the node's own.
  const seat = await deps.hostNode({ nodeId: input.nodeId, rootId: input.rootId, depth: input.depth });
  let run: NodeLoopResult;

  try {
    // THE LOOP RUNS AS THE NODE. A home is uid/gid/mode on real inodes, so it
    // means nothing until the shell and the file plane the loop actually uses
    // are the node's own — which only the backend can build, hence the seam.
    // Resolved inside the try, because a runtime that cannot be built is a node
    // that produced no report and the row below owes that verdict either way.
    const rt = deps.runtimeForWorkspace ? await deps.runtimeForWorkspace(home, input) : seat.actor.runtime;
    run = await runNodeLoop(spec, nodeLoopDeps(input, deps, seat, rt));
  } catch (cause) {
    if (deps.signal?.aborted) {
      // THE CANCELLATION ARRIVING, not a failure of the work. The loop answers its
      // own signal with an `aborted` report, so reaching here means the cut landed
      // outside it — while the node's runtime was still being built. The signal is
      // authoritative over the rejection's shape (the rule `runChat` already
      // applies), so the row reads the same either way, under the reason whoever
      // cancelled it gave.
      const reason = renderCauseChain(toKinuError({
        doing: `cancel node ${input.nodeId} of this search`, cause: abortCause(deps.signal), otherwise: 'cancelled',
      }));

      run = {
        report: unreportedNode(input.nodeId, nodeBudget.spawnedAt, {
          status: 'aborted',
          summary: `Node ${input.nodeId} was cancelled before it reported: ${reason}`,
          errorMessage: reason,
        }),
        reported: null, granted: null, produced: [],
        languages: seat.actor.runtime.executor.languages,
      };
    } else {
      const failure = toKinuError({
        doing: `run node ${input.nodeId} of this search`, cause, otherwise: 'unavailable',
      });

      const chain = renderCauseChain(failure);
      deps.journal.recordReport(unreportedNode(input.nodeId, nodeBudget.spawnedAt, {
        status: 'errored',
        summary: `Node ${input.nodeId} produced no report: ${chain}`,
        errorMessage: chain,
      }));
      throw failure;
    }
  }

  deps.journal.recordReport(run.report);
  deps.reportModelCall?.({ source: 'swarm', usage: run.report.usage });

  const read = readNodeReport({
    report: run.report,
    reported: run.reported,
    languages: run.languages,
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
 * The report of a node that produced none — the transport ended the run before
 * the loop could answer, whether by failing or by carrying out a cancellation.
 *
 * ZERO AND `{}` ARE READINGS, not defaults. No report came back, so nothing here
 * can say what the node spent; `recordReport` stores an absent usage field as
 * NULL, which keeps "the provider never reported" distinguishable from "reported
 * zero". Whatever steps the node did manage are already in `head_steps` under its
 * own id, which is the progress record either way.
 */
function unreportedNode(
  nodeId: string,
  spawnedAt: number,
  verdict: { status: 'errored' | 'aborted'; summary: string; errorMessage: string },
): HeadReport {
  return {
    id: nodeId,
    status: verdict.status,
    summary: verdict.summary,
    evidence: [], decisions: [], artifactRefs: [], fileChanges: [], childHeadIds: [],
    toolCalls: [],
    stepCount: 0,
    usage: {},
    wallClockMs: Date.now() - spawnedAt,
    errorMessage: verdict.errorMessage,
  };
}

/**
 * The in-isolate seams: the search's own journal and arbiter, called directly.
 *
 * A host builds the same shape out of RPCs to the parent instead. Separated so
 * the two transports differ in this function alone.
 */
function nodeLoopDeps(input: NodeAgentInput, deps: NodeAgentDeps, seat: HostedNodeSeat, rt: AgentRuntime): NodeLoopDeps {
  const loop: NodeLoopDeps = {
    // The SAME hosted actor — same handle, same stores over the one workspace
    // database, same session — with the runtime the home provisioner rebuilt
    // when it rebuilt one. A re-provisioned runtime changes which credential
    // the shell and the file plane act as; it does not change who the actor is.
    actor: rt === seat.actor.runtime ? seat.actor : { ...seat.actor, runtime: rt },
    runId: seat.runId,
    profile: seat.profile,
    dynamic: seat.dynamic,
    model: deps.model,
    logger: deps.logger,
    arbitrate: input.arbitrate,
    reportStep: (seq, step) => { deps.journal.appendStep(input.nodeId, seq, step); },
  };

  if (deps.signal !== undefined) loop.signal = deps.signal;
  // The run-level channel, bound to THIS node's id — the same binding
  // `reportStep` above makes for its durable rows.
  const publish = deps.publishHeadStream;

  if (publish !== undefined) {
    loop.reportDelta = (kind, delta) => {
      publish({ headId: input.nodeId, kind, delta });
    };
  }

  if (deps.mission !== undefined) loop.mission = deps.mission;

  if (deps.executeTool !== undefined) loop.executeTool = deps.executeTool;

  if (deps.webSearch !== undefined) loop.webSearch = deps.webSearch;

  if (deps.gradeReport !== undefined) loop.gradeReport = deps.gradeReport;

  if (deps.backgroundPolicy !== undefined) loop.backgroundPolicy = deps.backgroundPolicy;

  return loop;
}
