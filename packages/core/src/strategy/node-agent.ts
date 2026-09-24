/**
 * One node of a swarm, as an agent: docs/EXPLORATION.md "A node is an agent", "Node identity",
 * "Inherited context", "The report contract", "Arbitration", "Isolation", "The journal read model".
 * The loop is {@link runHeadInference}; do not add a second one. A node is graded on what it
 * reports, never on workspace state; {@link readNodeReport} is the only report boundary.
 */

import { REAL_CLOCK, type Clock } from '../types/clock';
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
 * A head's builtins plus `report`. Together with {@link NODE_WITHHELD_TOOLS} it must cover the
 * whole builtin surface (asserted by test).
 */
export const NODE_BUILTIN_TOOLS = [...HEAD_BUILTIN_TOOLS, 'report'] as const satisfies readonly BuiltinToolName[];

/** Builtins withheld from a node, each with its reason; absent a reason, a tool goes in. */
export const NODE_WITHHELD_TOOLS = {
  // Not a recursion guard: this tool is the search engine itself (an import ring), and a node
  // funds more actors only through the arbiter's shared budget.
  agents: 'the delegation tool IS the search engine (an import ring), and a node funds '
    + 'more actors only through the arbiter, which holds the budget it cannot see',
  memory: 'durable notes, facts and the past conversation live in per-workspace stores the node '
    + 'shares with its parent and siblings; search grades reports, not state left behind',
  tasks: 'one `agent_tasks` list per workspace, shared with the parent and siblings; '
    + 'its `mode` action selects the parent agent’s durable role',
} as const satisfies Readonly<Record<string, string>>;

export const PROPOSE_BRANCH_TOOL = 'propose_branch';


/** What the engine hands one node. Identity, depth and seed are engine-authored (*Node identity*, *Inherited context*). */
export interface NodeAgentInput extends NodeIdentity {
  readonly parentId: string | null;
  /** The node's assigned question, preserved in its journal row. */
  readonly task: string;
  /** Why this node exists: the search's own task at the root, the accepted
   *  branch's rationale below it. */
  readonly rationale: string;
  /** The search's half of the system prompt; the node's half is added by {@link nodeSystemPrompt}. */
  readonly base: string;
  readonly messages: readonly ModelMessage[];
  /** Empty under `context:'fresh'`. */
  readonly inherited: readonly SerializedMessage[];
  readonly context: BranchContext;
  readonly mode: WorkMode;
  readonly settle: SwarmSettle;
  /** The routed model spec for this node's slot, recorded on `HeadInput.model`. Absent on an unrouted run. */
  readonly modelSpec?: string | undefined;
  /**
   * Null means the tool is absent (*Build-time exclusion*); a refusal at runtime covers a budget
   * that empties mid-run.
   */
  readonly arbitrate: NodeArbiter | null;
}

/** What a node's own run produced, as the engine consumes it. */
export interface NodeRun {
  readonly report: HeadReport;
  /** The reported candidate: code-fenced content first, else the whole conclusion. */
  readonly candidate: string;
  readonly granted: BranchDecision | null;
  readonly usage: Usage;
  readonly isolation: NodeIsolation;
  /** Whether the node finished via its own `report` call rather than final prose. */
  readonly reportedItself: boolean;
  /**
   * What a `context:'inherit'` child inherits. Append-only so siblings share a byte-identical
   * cacheable prefix.
   */
  readonly produced: readonly ModelMessage[];
}

/**
 * Deps a run assembles once for every node. Mutable so optional members stay absent keys
 * rather than `undefined`; not mutated after the loop starts.
 */
export interface NodeAgentDeps {
  /**
   * Acquire the hosted actor one node runs as. A factory: deps are shallow-copied per child, so a
   * single actor here would share one claim ledger across a wave.
   */
  hostNode: (node: NodeIdentity) => Promise<HostedNodeSeat>;
  model: LanguageModel;
  /** A transcript is a read model over the node's journal (*The journal read model*). */
  journal: HeadJournal;
  logger: Logger;
  signal?: AbortSignal;
  clock?: Clock;
  reportModelCall?: ModelCallSink;
  publishHeadStream?: PublishHeadStream;
  mission?: MissionScope;
  /** Absent on a host with no uid-0 view; the shared plane is then reported. */
  provisionHome?: NodeWorkspaceProvisioner;
  /**
   * The same workspace addressed as the node; only the backend can rebuild the credentialed
   * shell and file plane. Null or absent keeps the seat's own runtime.
   */
  runtimeForWorkspace?: ((workspace: NodeWorkspace, identity: NodeIdentity) => Promise<AgentRuntime>) | null;
  nodeCodemode?: NodeCodemode;
  webSearch?: WebSearchProvider;
  gradeReport?: (candidate: string) => Promise<string | null>;
  backgroundPolicy?: () => BackgroundPolicy;
}





/** A node's `eval` over the actor it runs as, whose runtime may be rebuilt for its home. */
export type NodeCodemode = (actor: HostedActor) => (finished: ToolSet) => ToolSet[string];

/** One node's own actor and its per-turn seams; returned by {@link NodeAgentDeps.hostNode} because each is per actor. */
export interface HostedNodeSeat {
  readonly actor: HostedActor;
  /** The activation's run id; every turn this node admits is claimed under it. */
  readonly runId: string;
  /** Same role and tier narrowing an actor's chat turn resolves. */
  readonly profile: (input: { readonly availableTools: readonly string[]; readonly workMode: WorkMode })
    => Promise<{ readonly profile: ResolvedTurnProfile; readonly inputs: ProfileAuthorityInputs }>;
  /** This node's own live per-step block (its jobs, tasks, approvals). */
  readonly dynamic: (profile: ResolvedTurnProfile, tools: ToolSet) => DynamicContext;
}

export interface NodeLoopDeps {
  /**
   * The hosted actor this node is: a node's turn writes a durable claim, so it needs an identity,
   * `actor.runtime` and claimed turns on `actor.session`.
   */
  actor: HostedActor;
  runId: string;
  profile: (input: { readonly availableTools: readonly string[]; readonly workMode: WorkMode })
    => Promise<{ readonly profile: ResolvedTurnProfile; readonly inputs: ProfileAuthorityInputs }>;
  dynamic: (profile: ResolvedTurnProfile, tools: ToolSet) => DynamicContext;
  model: LanguageModel;
  logger: Logger;
  signal?: AbortSignal;
  clock: Clock;
  mission?: MissionScope;
  reportStep?: (seq: number, step: HeadStep) => Promise<void> | void;
  /** Transient frames while a step is produced, superseded by `reportStep`'s row (heads/head-stream.ts). */
  reportDelta?: ReportHeadDelta;
  arbitrate: NodeArbiter | null;
  codemodeTool?: unknown;
  webSearch?: WebSearchProvider;
  /**
   * The report contract's gate: null lets the report land, else the text is the node's next instruction.
   * Decides whether the instrument ran, not whether the answer is good (*No self-grading*). Absent
   * when the run has no instrument. Retries are bounded by the node's own step budget.
   */
  gradeReport?: (candidate: string) => Promise<string | null>;
  /** Defaults to `BACKGROUND_POLICY.interactive`; overridable so tests need not wait out the real threshold. */
  backgroundPolicy?: () => BackgroundPolicy;
}

/** Where a node's report and granted branch land while it runs. */
interface NodeScratch {
  reported: CapturedReport | null;
  granted: BranchDecision | null;
  proposal: Promise<BranchDecision> | null;
  produced: readonly ModelMessage[];
}

/** *Arbitration* as a tool: the verdict is the return value, and a refusal's text is written for the node. */
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
        // Once per node: the engine reads only the last grant, so a second arbitrate would debit the
        // budget again and strand the first grant.
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

        // The width band is enforced by the arbiter so an out-of-range request gets a reason-coded
        // refusal; the AI SDK does not validate `jsonSchema` input.
        const attempt = Promise.resolve(arbitrate({
          rationale,
          branches: branches.map((branch) => ({
            task: branch.task,
            rationale: branch.rationale,
            // An absent `context` narrows to 'fresh'.
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
 * Confined builtins, the report tool, and the proposal when one could be granted. Every call is
 * recorded into the capture.
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

  // Annotated rather than inline: the only destination that declares `bodyOnly`.
  const report: ReportToolDeps = {
    // A node is measured only on the candidate extracted from `content`; handoff fields reach nobody.
    bodyOnly: true,
    report: async ({ status, content }): Promise<JsonValue> => {
      // The gate reads the candidate through {@link candidateOf}, the engine's own extractor.
      const errors = await deps.gradeReport?.(
        candidateOf(content.trim(), deps.actor.runtime.executor.languages),
      );

      if (errors !== undefined && errors !== null) {
        // Not written to `scratch.reported`, so the node keeps running with the errors as its next instruction.
        return { accepted: false, errors };
      }

      scratch.reported = { status, content };

      return { received: true };
    },
  };

  // The proposal merges after the finish, so the sandbox never declares it; the background wrap
  // runs inside the capture so the transcript records the handle the model was told.
  return buildToolSurface({
    rt: deps.actor.runtime,
    history: deps.actor.stores.history,
    workMode: input.mode,
    logger: deps.logger,
    report,
    webSearch: deps.webSearch,
    admitted: NODE_BUILTIN_TOOLS,
    codemodeTool: deps.codemodeTool,
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
 * What the engine takes out of a finished node: the measured candidate and the seed conclusion.
 * No score (*No self-grading*). A fence in a language the executor can't run is kept whole.
 */
export interface NodeReport {
  readonly candidate: string;
  readonly conclusion: string;
}

/** The text an instrument measures. Shared by the gate and the engine so both measure the same text. */
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
  // An empty captured report falls back to the head's summary.
  const captured = input.reported?.content.trim() ?? '';
  const conclusion = captured === '' ? input.report.summary.trim() : captured;

  return { candidate: candidateOf(conclusion, input.languages), conclusion };
}

/** The node's system prompt; not the head prompt, whose fork/evidence/split framing is false for a node. */
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
 * The node loop, reached only through {@link runNodeAgent}. A turn may end with background work
 * still running; the node takes another turn when the wake lands. Journals nothing: the ledger is the search's.
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

  // In-process counterpart of the actor's durable queue, behind the same `AgentInbox` seam.
  const wakes = new AgentWakeQueue();
  // Reconciled here: nothing guarantees this actor's jobs table was opened before.
  initBackgroundJobsTable(deps.actor.runtime.storage.execRaw);

  const runnerDeps: BackgroundJobRunnerDeps = {
    store: deps.actor.stores.jobs,
    fiber: deps.actor.runtime.schedule.fiber.bind(deps.actor.runtime.schedule),
    inbox: wakes,
    logActivity: (event, detail) => {
      deps.logger.event('swarm.node_job', {
        nodeId: spec.headInput.id, job: event, detail: detail ?? '',
      });
    },
    // No `eventLog`/`scheduleDrain`/`resume`: a node is abandoned with its run, so there is no later
    // activation to deliver to.
  };

  // An absent policy must be an absent key: the runner reads presence to pick the default.
  if (deps.backgroundPolicy !== undefined) runnerDeps.policy = deps.backgroundPolicy;
  const jobRunner = new BackgroundJobRunner(runnerDeps);

  // A null arbiter is the only spelling of "no branch can be granted here".
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
    clock: deps.clock,
    model: deps.model,
    tools,
    // Must match what `isolationDisclosure` tells the node.
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
    // A reported node is finished; an unreported one waits while a job runs or a wake is queued.
    resume: async () => {
      if (scratch.reported !== null) return null;

      return wakes.next(() => jobRunner.inFlight > 0);
    },
  };

  // Absent seams must be absent keys: `runHeadInference` reads presence.
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
    // Cancel this runner's jobs: their results have no reader left.
    jobRunner.cancelRunning();
  }
}

/**
 * Run one node as an agent, and journal it. Loop failures are reports; transport failures
 * (actor or runtime acquisition) throw, after journalling the node terminal so its `running` row
 * does not outlive it.
 */
export async function runNodeAgent(
  input: NodeAgentInput,
  deps: NodeAgentDeps,
): Promise<NodeRun> {
  const home = await nodeWorkspace(
    { nodeId: input.nodeId, rootId: input.rootId, depth: input.depth },
    deps.provisionHome,
  );

  const nodeBudget: HeadBudget = { maxDepth: 0, spawnedAt: Date.now() };

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
    // A label only; `ResolvedSwarm.settle` is the fact.
    mergeStrategy: input.settle === 'best' ? 'best_of' : 'synthesize',
    // A node states its loop pointer rather than inheriting the parent's.
    loop: defaultLoopOrigin('head'),
  };

  // The row's copy of ledger and route (`cli-backend/head-runtime.ts` reads these). Assigned only
  // when present so an unbudgeted/unrouted run carries no key.
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

  // Whoever opened the row owes its terminal write. Actor acquisition failure is rethrown before
  // the try; runtime failure is inside it because the row owes that verdict.
  const seat = await deps.hostNode({ nodeId: input.nodeId, rootId: input.rootId, depth: input.depth });
  let run: NodeLoopResult;

  try {
    // The loop runs as the node: only the backend can build the node's credentialed runtime.
    const rt = deps.runtimeForWorkspace ? await deps.runtimeForWorkspace(home, input) : seat.actor.runtime;
    run = await runNodeLoop(spec, nodeLoopDeps(input, deps, seat, rt));
  } catch (cause) {
    if (deps.signal?.aborted) {
      // Cancelled while the runtime was being built; the signal is authoritative over the rejection.
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
 * The report of a node that produced none. Empty usage is stored as NULL, keeping "never
 * reported" distinct from zero.
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

/** In-isolate seams: the search's own journal and arbiter, called directly. */
function nodeLoopDeps(input: NodeAgentInput, deps: NodeAgentDeps, seat: HostedNodeSeat, rt: AgentRuntime): NodeLoopDeps {
  const loop: NodeLoopDeps = {
    // Same actor, with the rebuilt runtime when the provisioner made one.
    actor: rt === seat.actor.runtime ? seat.actor : { ...seat.actor, runtime: rt },
    runId: seat.runId,
    profile: seat.profile,
    dynamic: seat.dynamic,
    model: deps.model,
    logger: deps.logger,
    // Real time unless the run handed a clock (D19).
    clock: deps.clock ?? REAL_CLOCK,
    arbitrate: input.arbitrate,
    reportStep: (seq, step) => { deps.journal.appendStep(input.nodeId, seq, step); },
  };

  if (deps.signal !== undefined) loop.signal = deps.signal;
  const publish = deps.publishHeadStream;

  if (publish !== undefined) {
    loop.reportDelta = (kind, delta) => {
      publish({ headId: input.nodeId, kind, delta });
    };
  }

  if (deps.mission !== undefined) loop.mission = deps.mission;

  if (deps.nodeCodemode !== undefined) loop.codemodeTool = deps.nodeCodemode(loop.actor);

  if (deps.webSearch !== undefined) loop.webSearch = deps.webSearch;

  if (deps.gradeReport !== undefined) loop.gradeReport = deps.gradeReport;

  if (deps.backgroundPolicy !== undefined) loop.backgroundPolicy = deps.backgroundPolicy;

  return loop;
}
