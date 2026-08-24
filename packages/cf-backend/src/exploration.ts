/**
 * ExplorationAgent — the parallel sub-agent Facet.
 *
 * One class, three modes — and the difference between them is the whole point:
 *
 *   MCTS mode — short-form one-shot rollouts for the MCTS engine. @callable
 *               explore() is a single bare generateText with NO ToolSet and NO
 *               runtime, so a branch has no filesystem to isolate and storage
 *               isolation (lean/Proteus/MCTS/StorageIsolation.lean) holds by DO
 *               identity alone. generateReflection() produces a failure
 *               post-mortem. Scoring lives in core (mcts/evaluation.ts via the
 *               engine seam) — branches do not rate themselves.
 *               A branch must NEVER acquire the head runtime below.
 *
 *   HEAD mode — long-form multi-step inference for the branching-heads
 *               primitive (the `agents` tool's fork action). initHead() /
 *               runAsHead() / abortHead() drive an agentic loop over the
 *               canonical workspace filesystem, Nimbus processes/ports,
 *               sandbox and device consent (see headRuntime()). Its tool surface —
 *               and the containment that keeps the delegation surface off it —
 *               is declared in @kinu.run/core head-tools.
 *
 *   NODE mode — one node of a swarm search, HOSTED. initNode() takes core's
 *               NodeRunSpec over RPC and runAsNode() calls the very same
 *               runNodeLoop() an in-isolate node runs, rebuilding here only the
 *               live seams a serialisable spec cannot carry: the model, the
 *               runtime, the search's arbiter and its step journal. Hosting buys
 *               a storage boundary and a teardown verb, not parallelism —
 *               facets share one thread.
 *
 * All three modes share: Facet class, composed owner/model services, lifecycle,
 * and parallel-spawn infrastructure. Heads are a mode of this Facet, not a
 * separate agent class. ExplorationAgent extends the bare `Agent`, never
 * `ActorAgent`, so no head can inherit the full actor tool surface.
 *
 * Constraints (Agent SDK facets, verified against agents 0.14.1 dist):
 *   • schedule()/keepAlive()/runFiber() WORK in facets — each delegates to
 *     the root DO (_cf_scheduleForFacet / _cf_acquireFacetKeepAlive /
 *     _cf_registerFacetRun), which owns the single physical alarm slot.
 *     This class simply doesn't need them.
 *   • Own SQLite — independent from the orchestrator's (shares the parent
 *     DO's storage quota)
 *   • LLM config derived per-call from the owner user's provider registry
 */

import { Agent, callable, type AgentContext, type SubAgentClass } from "agents";
import { EXPLORATION_RPC_SURFACE, sealRpcSurface } from "./rpc-surface";
import { generateText } from "ai";
import { explorePrompt, formatInheritedContext, isWorkMode, normalizeUsage, reflectionPrompt } from "@kinu.run/core";
import type { OrchestratorAgent } from "./orchestrator";
import {
  type CraftedTool,
  type HeadId,
  type HeadInput,
  type HeadReport,
  type WebSearchProvider,
  type HeadStep,
  type Decision,
  type MergeStrategy,
  type HeadBudget,
  type MergeResult,
  type SqlExecutor,
  HeadController,
  type HeadJournalPort,
  type BranchExploration,
  type BranchReflection,
  HeadCapture,
  runHeadInference,
  runNodeLoop,
  type NodeRunSpec,
  type NodeLoopDeps,
  type NodeLoopResult,
  type MissionScope,
  type ModelOperationSink,
  type WorkMode,
} from "@kinu.run/core";
import { OwnedModelServices } from "./owned-model-services";
import { FacetIdentity } from "./facet-identity";
import { createHeadRuntime } from "./head-runtime";
import { bindAgentSql, createCFRuntime, type CFRuntime, type CFRuntimeHooks } from "./runtime";
import { createExecuteToolsTool } from "./execute-tools";
import { buildHeadToolSet } from "@kinu.run/core";
import {
  createAgentTracing, createConsoleLogger, diagnostics, toKinuError, type AgentTracing,
} from "@kinu.run/core/obs";
import { createAgentConfigStore, initAgentConfigTable } from "@kinu.run/core";
import { createWorkersTracer } from "./obs/cf-tracer";

export class ExplorationAgent extends Agent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    sealRpcSurface(this, EXPLORATION_RPC_SURFACE);
  }

  /** A facet that splits further spawns the class it already is. Satisfies
   *  `FacetHost` — facet-spawn.ts imports this class type-only, so the VALUE has
   *  to come from the host, and here that is a plain self reference. */
  explorationFacet(): SubAgentClass<ExplorationAgent> { return ExplorationAgent; }

  // ── Head-mode state (MCTS mode is stateless beyond the traces table) ──
  private headInput: HeadInput | null = null;
  private headAborted = false;
  private headAbortReason: string | null = null;
  private nodeSpec: NodeRunSpec | null = null;

  /** Owner, capability token and parent workspace — one store, one schema.
   *  Every accessor below is a THUNK, never a construction-time value: a facet's
   *  logical `name` and its seeded identity are both set by the async
   *  `_cf_initAsFacet` AFTER this field initializes. */
  private readonly identity = new FacetIdentity(this.ctx.storage.sql);

  private readonly ownedModelServices = new OwnedModelServices({
    env: this.env,
    agentName: () => this.name,
    appTitle: 'Kinu (exploration)',
    ownerRequired: false,
    getOwnerUserId: () => this.identity.ownerUserId(),
    getUserCaller: async () => {
      const workspaceToken = this.identity.capabilityToken();
      if (!workspaceToken) throw new Error('This exploration facet was seeded without a workspace capability token.');
      return { workspaceToken };
    },
  });

  /** Memoized, like every other actor's. Rebuilding the binding per call cost a
   *  head one allocation per SQL statement it ran. */
  private _boundSql: SqlExecutor | null = null;
  private get boundSql(): SqlExecutor {
    if (!this._boundSql) this._boundSql = bindAgentSql(this);
    return this._boundSql;
  }

  /** Where THIS facet's model-operation frames go: forwarded over the same
   *  root RPC the merge's cost report uses (`reportFacetModelOperation`), for
   *  the reason that twin exists — a facet has no durable log of its own, so
   *  an operation row written locally would strand one Durable Object away
   *  from the spend row it explains. A missing parent is instrumentation
   *  losing its destination, not the merge failing: reported and dropped,
   *  exactly how core's shared projection treats a ledger fault. */
  private readonly modelOperations: ModelOperationSink = (event) => {
    const parent = this.getSharedParentStub();
    if (!parent) {
      diagnostics.failure('event.model_operation_emit_failed', toKinuError({
        doing: 'forwarding a model_operation frame to the root workspace',
        cause: new Error('no parent workspace'),
        otherwise: 'io',
      }), { operationId: event.operationId, phase: event.phase, source: event.source });
      return;
    }
    void parent.reportFacetModelOperation(event);
  };

  private _tracing: AgentTracing | null = null;

  /**
   * The same tracing seam the orchestrator has, on the facet, for the same
   * reason the owner gives for everything else: a node and its parent are the
   * same kind of thing and a capability only one of them has is a capability
   * neither can be reasoned about.
   *
   * This is the instrument the 2026-08-19 live run needed and did not have.
   * Three nodes, 605s, `swarm.node_silent` ×3 at ~600,000ms idle: zero steps,
   * zero model calls, zero tokens, no error. `insertSpawn` had run, so the rows
   * were `running` — something between the spawn and the first finished step
   * blocked forever, and nothing could say WHICH side of `runNodeLoop` it was on
   * because the only observable was the absence of rows the loop writes.
   * `runAsNode` is one RPC invocation, so its phases are spans, and an
   * unterminated `swarm.node.loop` under a terminated `swarm.node.deps` is the
   * whole diagnosis.
   *
   * `isolateGen` through `AgentConfigStore.countIsolateGeneration` — the same
   * function the orchestrator calls, over the same `IF NOT EXISTS` table, so the
   * counter means the same thing on both and a discontinuity is comparable
   * across a parent and its facets. `selfPath` and never `ctx.id`: two facets
   * with distinct ids both report under the ROOT's `durableObjectId`
   * (`do.facet.id_is_root_namespace`), which is exactly the collapse that would
   * make a per-node trace useless here.
   */
  private get tracing(): AgentTracing {
    if (!this._tracing) {
      initAgentConfigTable((ddl) => { this.ctx.storage.sql.exec(ddl); });
      this._tracing = createAgentTracing({
        tracer: createWorkersTracer(),
        isolateGen: createAgentConfigStore(this.boundSql).countIsolateGeneration(),
        selfPath: this.selfPath,
      });
    }
    return this._tracing;
  }

  /** A facet's private plane over the PARENT's file plane: private SQL ledgers and
   *  private shell state, from the one `createCFRuntime` call every mode that has a
   *  runtime at all shares.
   *
   *  `workspaceName` is the parent workspace and never this facet's own name.
   *  `SqliteVFS` is keyed `${ownerUserId}|${workspaceName}`, so a facet that named
   *  itself would derive a SECOND, EMPTY filesystem — the empty-workspace
   *  regression pinned by tests/unit-head-fork.test.ts. */
  private facetRuntime(scope: 'head' | 'node', hooks: CFRuntimeHooks): CFRuntime {
    const parent = this.getSharedParentStub();
    const workspaceName = this.identity.parentWorkspace();
    if (!parent || !workspaceName) {
      throw new Error(`This ${scope} was spawned without a parent workspace; setSharedParent must run before it can run.`);
    }
    return createCFRuntime(this, { env: this.env, ctx: this.ctx }, {
      ownerUserId: () => this.identity.ownerUserId(),
      workspaceName,
      shellId: `${scope}:${this.name}`,
      scaffoldPath: `.kinu/${scope}s/${encodeURIComponent(this.name)}/scaffold/agent.js`,
      capabilityToken: async () => this.identity.capabilityToken(),
    }, hooks);
  }

  /** A head's runtime: the shared plane above wrapped with this run's observer
   *  before tools are built, so writes are attributable without another executor
   *  or VFS. */
  private headRuntime(capture: HeadCapture): CFRuntime {
    return this.facetRuntime('head', { workspaceObserver: capture.files });
  }

  /** ExplorationAgents inherit ownership from the orchestrator that spawned
   *  them; the parent calls setOwner immediately after subAgent() returns
   *  the stub. The workspace capability token comes down with it, so a head's
   *  model calls reach the owner's credentials as the PARENT workspace and are
   *  attenuated exactly as it is. Persisted to SQL so hibernation between spawn
   *  + run is safe. */
  @callable()
  async setOwner(userId: string, capabilityToken: string | null): Promise<{ ok: true }> {
    if (!userId) throw new Error('userId required');
    this.identity.setOwner(userId, capabilityToken);
    this.ownedModelServices.invalidate();
    return { ok: true };
  }

  /** The ROOT workspace this head forks: whose canonical Nimbus session and
   *  execution planes it shares, where the whole split's findings accumulate,
   *  and — since C2 — where every journal row the subtree writes lands. Set by
   *  the spawner right after subAgent() and propagated UNCHANGED to recursive
   *  sub-heads, so an intermediate head never becomes the tree's workspace.
   *  Persisted for hibernation. */
  @callable()
  async setSharedParent(agentName: string): Promise<{ ok: true }> {
    if (!agentName) throw new Error('agentName required');
    this.identity.setParentWorkspace(agentName);
    return { ok: true };
  }

  /** Stub to the root workspace orchestrator — the head's parent — or null if
   *  unset (an MCTS branch never has one). */
  private getSharedParentStub(): DurableObjectStub<OrchestratorAgent> | null {
    const name = this.identity.parentWorkspace();
    if (!name) return null;
    return this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(name));
  }

  /** Activation init, synchronous by contract — see `OrchestratorAgent.onStart`
   *  and `scripts/do-init-gate.ts`, which refuses the widening. Only the MCTS
   *  trace table: `FacetIdentity` creates its own on first touch, so a branch
   *  that never carries an identity never pays for the table. */
  onStart(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(9)))),
        step       INTEGER NOT NULL,
        text       TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      )
    `);
  }

  // ── MCTS mode @callables ────────────────────────────────────────
  // Deliberately toolless and runtime-free: a branch reasons, it does not act.
  // Nothing here may reach headRuntime().

  /** Traced because this is the ONE model call a branch makes, so its span IS the
   *  branch's latency — and a 120s branch-RPC cap once silently killed every
   *  rollout against turns measuring 151/294/509s. A measured span is what makes
   *  the next such number arguable instead of guessed. */
  @callable()
  async explore(
    priorHistory: Array<{ role: string; content: string }>,
    craftedTools: CraftedTool[],
    languages: readonly [string, ...string[]],
    mode: WorkMode,
    siblings: readonly string[] = [],
  ): Promise<BranchExploration> {
    if (!isWorkMode(mode)) throw new Error('Branch exploration requires a trusted work mode');
    return await this.tracing.invocation('rpc', 'mcts.branch', async (invocation) => {
      const { model, providerOptions } = this.ownedModelServices.resolveModelWithEffort(null, 'low');
      const { system, user } = explorePrompt({
        mode,
        context: formatInheritedContext(priorHistory),
        craftedTools,
        languages,
        siblings,
      });

      const request: Parameters<typeof generateText>[0] = {
        model,
        system,
        messages: [{ role: "user" as const, content: user }],
      };
      if (providerOptions) request.providerOptions = providerOptions;
      const { text, usage } = await invocation.span('mcts.branch.model', async (span) => {
        const answer = await generateText(request);
        span.setAttribute('kinu.output_tokens', answer.usage.outputTokens ?? 0);
        return answer;
      });

      const trimmed = text.trim();
      void this.sql`INSERT INTO traces (step, text) VALUES (1, ${trimmed})`;
      return { text: trimmed, usage: normalizeUsage(usage) };
    });
  }

  @callable()
  async generateReflection(task: string, outcome?: string): Promise<BranchReflection> {
    const traces = this.sql<{ text: string }>`SELECT text FROM traces ORDER BY step`;
    const { model, providerOptions } = this.ownedModelServices.resolveModelWithEffort(null, 'low');
    const request: Parameters<typeof generateText>[0] = {
      model,
      messages: [{
        role: "user" as const,
        content: reflectionPrompt(task, traces.map(t => t.text).join("\n"), outcome),
      }],
    };
    if (providerOptions) request.providerOptions = providerOptions;
    const { text, usage } = await generateText(request);
    return { text: text.trim(), usage: normalizeUsage(usage) };
  }

  // ── Head mode @callables  ───────────────────────────────────

  /** Initialize this facet as a branching-heads worker. */
  @callable()
  async initHead(input: HeadInput): Promise<{ ok: true; id: HeadId }> {
    this.headInput = input;
    this.headAborted = false;
    this.headAbortReason = null;
    return { ok: true, id: input.id };
  }

  @callable()
  async abortHead(reason: string): Promise<{ ok: true }> {
    this.headAborted = true;
    this.headAbortReason = reason;
    return { ok: true };
  }

  /** Run the head's inference loop over the forked runtime and return its
   *  HeadReport. The ToolSet — and what is deliberately absent from it — is
   *  declared in @kinu.run/core head-tools.
   *
   *  Traced with the same two phases as `runAsNode`, for the same reason: a head
   *  that produces no report has either failed to acquire its model and tools or
   *  failed inside the loop, and those are different defects with the same
   *  observable. */
  @callable()
  async runAsHead(): Promise<HeadReport> {
    if (!this.headInput) throw new Error("ExplorationAgent.runAsHead() called before initHead()");
    const input = this.headInput;
    return await this.tracing.invocation('rpc', 'head.run', async (invocation, root) => {
      root.setAttribute('kinu.head_id', input.id);
      const capture = new HeadCapture();
      // The loop + report assembly live in core (runHeadInference); the Facet
      // supplies its model + the forked tool surface. Abort is driven by
      // abortHead() flipping this.headAborted.
      const headOptions = invocation.span('head.deps', (): Parameters<typeof runHeadInference>[1] => {
        const mission = this.missionScope(input);
        const options: Parameters<typeof runHeadInference>[1] = {
          model: this.ownedModelServices.resolveModel(input.model),
          tools: this.buildHeadTools(input, capture),
          capture,
          workspaceLayout: 'shared-workspace',
          isAborted: () => this.headAborted,
          abortReason: () => this.headAbortReason,
        };
        if (mission) options.mission = mission;
        // Null only when this facet has no parent, which is an MCTS branch.
        const parent = this.getSharedParentStub();
        if (parent) options.reportStep = this.stepSink(parent, input.id);
        return options;
      });
      return await invocation.span('head.inference', async (span) => {
        const report = await runHeadInference(input, headOptions);
        span.setAttribute('kinu.head_status', report.status);
        return report;
      });
    });
  }

  // ── Node mode @callables ────────────────────────────────────────

  /** Initialize this facet as one swarm node's host. */
  @callable()
  async initNode(spec: NodeRunSpec): Promise<{ ok: true; id: string }> {
    this.nodeSpec = spec;
    return { ok: true, id: spec.headInput.id };
  }

  /**
   * Run this node's loop and return everything the search takes out of it.
   * Journals nothing — the ledger is the parent's, which is why the step sink and
   * the arbiter below are RPCs back to it rather than local writes.
   *
   * TRACED as one invocation with two sibling phases, and the split is the
   * diagnosis rather than decoration. `swarm.node.deps` covers everything before
   * the loop: the facet runtime, the model resolution (which reaches the owner's
   * credentials over RPC and can therefore block), the tool surface. `swarm.node.loop`
   * covers `runNodeLoop`. A node reported silent for 600s with zero steps and
   * zero model calls is now a question with an answer — whichever of the two spans
   * has no end is the one that blocked — where before it was two indistinguishable
   * hypotheses over the same absence of rows.
   */
  @callable()
  async runAsNode(): Promise<NodeLoopResult> {
    if (!this.nodeSpec) throw new Error("ExplorationAgent.runAsNode() called before initNode()");
    const spec = this.nodeSpec;
    return await this.tracing.invocation('rpc', 'swarm.node', async (invocation, root) => {
      root.setAttribute('kinu.node_id', spec.headInput.id);
      const deps = invocation.span('swarm.node.deps', (): NodeLoopDeps => {
        // Named `parent` like every other acquisition of this stub, and not only for
        // style: unit-rpc-surface.test.ts derives a facet's cross-DO calls by that
        // local's name, so a second spelling shrinks the scan silently. It did —
        // `nodeArbitrate` went unchecked while this one was called something else.
        const parent = this.getSharedParentStub();
        if (!parent) {
          throw new Error('This node was spawned without a parent search; setSharedParent must run before runAsNode.');
        }
        const nodeId = spec.headInput.id;
        const rt = this.facetRuntime('node', {});
        const webSearch = this.ownedModelServices.getWebSearchProvider();
        const built: NodeLoopDeps = {
          rt,
          model: this.ownedModelServices.resolveModel(spec.headInput.model),
          logger: createConsoleLogger(),
          // The runtime half of the arbitration rule. Its build-time half is
          // `spec.canPropose`, which the search decided: a stub is always non-null, so
          // presence alone cannot answer whether a branch could be granted.
          arbitrate: spec.canPropose ? (proposal) => parent.nodeArbitrate(nodeId, proposal) : null,
          reportStep: this.stepSink(parent, nodeId),
          executeTool: this.facetExecuteTool(rt, spec.headInput, webSearch),
          webSearch,
        };
        // Assigned rather than spread: an unbudgeted node must leave the key ABSENT,
        // because the loop reads presence to decide whether the ledger exists at all.
        const mission = this.missionScope(spec.headInput);
        if (mission) built.mission = mission;
        return built;
      });
      return await invocation.span('swarm.node.loop', async (span) => {
        const result = await runNodeLoop(spec, deps);
        // The two facts that distinguish every outcome the search cares about
        // from the silent one: a node that never reached a model call reports
        // neither a status nor a report, and this span then has no end at all.
        span.setAttribute('kinu.node_status', result.report.status);
        span.setAttribute('kinu.node_reported', result.reported !== null);
        return result;
      });
    });
  }

  /**
   * Where this facet's finished steps go: the parent's journal, over RPC, as each
   * one lands.
   *
   * Same shape and same reason as {@link missionScope} — the journal lives on the
   * orchestrator and a facet cannot write it directly. It is what makes a running
   * branch readable: the trace is the only thing that can say what a head is
   * doing before it reports, and the surface renders it as it arrives.
   *
   * ONE sink for a head and a node alike, because a node's rows ARE head-journal
   * rows — `insertSpawn` takes a `HeadInput` and `appendStep` writes the same
   * table. The stub is passed in rather than resolved here because only one caller
   * has an absence to handle: a node has already refused to run without a parent,
   * and a head without one is an MCTS branch, which has no multi-step trace.
   */
  private stepSink(parent: DurableObjectStub<OrchestratorAgent>, headId: HeadId) {
    return async (seq: number, step: HeadStep): Promise<void> => {
      await parent.recordHeadStep(headId, seq, step);
    };
  }

  /**
   * The mission ledger this head charges, or null when it charges none.
   *
   * The ledger lives on the parent workspace — a facet has its own storage and
   * resolves its own model, so nothing the parent wrapped around `rt.llm`
   * reaches these calls. The port is therefore an RPC back to the actor that
   * declared the budget: guard before each step, debit after it.
   *
   * Null for a head with no labels, which is every head of an ordinary
   * unbudgeted run: no stub is taken, no RPC is issued, and the parent's
   * mission table is never opened.
   */
  private missionScope(input: HeadInput): MissionScope | null {
    const labels = input.missionLabels ?? [];
    if (labels.length === 0) return null;
    const parent = this.getSharedParentStub();
    if (!parent) return null;
    return {
      labels,
      port: {
        guard: (seam, scope) => parent.missionGuard(seam, scope),
        debit: (tokens, opts) => parent.missionDebit(tokens, opts),
      },
    };
  }

  // ── Head-mode tool builders ─────────────────────────────────────

  private buildHeadTools(input: HeadInput, capture: HeadCapture) {
    const rt = this.headRuntime(capture);
    const webSearch = this.ownedModelServices.getWebSearchProvider();
    return buildHeadToolSet({
      input,
      capture,
      rt,
      executeTool: this.facetExecuteTool(rt, input, webSearch),
      webSearch,
      split: (request) => this.runRecursiveSplit(request, input.budget, input),
    });
  }

  /** The `execute_tools` surface a facet's mode gets over its own runtime. One
   *  builder for a head and a node, because they differ in nothing but which
   *  `HeadInput` names the model a crafted script may call. */
  private facetExecuteTool(rt: CFRuntime, input: HeadInput, webSearch: WebSearchProvider) {
    return createExecuteToolsTool({
      loader: this.env.LOADER,
      rt,
      sql: this.boundSql,
      registry: this.ownedModelServices.providerRegistry(),
      modelSpec: () => input.model ?? null,
      webSearch,
    });
  }

  // ── Recursive split — head spawns more heads (itself ExplorationAgent facets)
  private async runRecursiveSplit(
    request: { rationale: string; heads: Array<{ task: string; rationale: string }>; mergeStrategy: MergeStrategy },
    parentBudget: HeadBudget,
    parentInput: HeadInput,
  ): Promise<{
    narrative: string;
    decisions: readonly Decision[];
    unresolvedQuestions: readonly string[];
    blindSpots: readonly string[];
    childHeadIds: readonly HeadId[];
    headCount: number;
  }> {
    // The subtree's journal belongs to the ROOT, never to this intermediate
    // facet. Journalling locally is the C2 defect: a depth-1 head wrote its
    // children's spawn/report rows into its OWN SQLite while their step rows
    // were recorded on the root, so the surface's head_journal -> head_steps
    // join could never match and a depth-2 head was unreadable from anywhere.
    // One place for both halves, reached over the same cross-DO port the
    // mission ledger uses.
    const parent = this.getSharedParentStub();
    if (!parent) {
      throw new Error(
        'A recursive split needs its root workspace; setSharedParent must run before split_subheads.',
      );
    }
    const journal: HeadJournalPort = {
      recordSplit: (rootId, rationale, spawnedAt) =>
        parent.headJournalRecordSplit(rootId, rationale, spawnedAt),
      insertSpawn: (childInput) => parent.headJournalInsertSpawn(childInput),
      recordReport: (report) => parent.headJournalRecordReport(report),
      cacheMerge: (rootId, result, strategy) =>
        parent.headJournalCacheMerge(rootId, result, strategy),
    };
    const runtime = createHeadRuntime({
      host: this,
      identity: async () => ({
        ownerUserId: this.identity.ownerUserId(),
        capabilityToken: this.identity.capabilityToken(),
        // The ROOT orchestrator, propagated unchanged so the whole subtree
        // shares one findings scratch (not this intermediate head).
        sharedParent: this.identity.parentWorkspace(),
      }),
      models: this.ownedModelServices,
      mergeModelSpec: () => parentInput.model ?? null,
      // Reported to the root over the same cross-DO port the journal above uses,
      // because that is where the workspace's total is assembled.
      reportModelCall: (report) => { void parent.reportFacetModelCall(report); },
      // The merge's operation frames go to the root beside its cost report.
      operations: this.modelOperations,
      // No `grounding`: a subtree's merge stays n=1 with neutral head scores.
      // Grounding one multiplies it into `mergeSamples` syntheses plus a judge
      // pass per head, and whether every level pays that is a heads-policy call.
    });

    const controller = new HeadController(runtime, journal);
    const controllerInput: Parameters<HeadController['run']>[0] = {
      parentHeadId: parentInput.id,
      rootId: parentInput.rootId,
      inheritedContext: parentInput.inheritedContext,
      request: { rationale: request.rationale, heads: request.heads, mergeStrategy: request.mergeStrategy },
      parentBudget,
      mode: parentInput.mode,
      model: parentInput.model,
      // A subtree charges the same mission its root does — otherwise a head
      // escapes its budget simply by splitting again.
    };
    if (parentInput.missionLabels?.length) controllerInput.missionLabels = parentInput.missionLabels;
    const result: MergeResult = await controller.run(controllerInput);

    return {
      narrative: result.mergedNarrative,
      decisions: result.selectedDecisions,
      unresolvedQuestions: result.unresolvedQuestions,
      blindSpots: result.blindSpots,
      childHeadIds: result.headIds,
      headCount: result.costSummary.headCount,
    };
  }

  // The head loop, system prompt, inherited context and report assembly live in
  // core (runHeadInference); the tool surface lives in @kinu.run/core head-tools. This
  // Facet supplies the three things only it can: the model, the forked runtime,
  // and the facet-spawn substrate behind split_subheads.
}
