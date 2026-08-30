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
import {
  beginModelOperation, explorePrompt, formatInheritedContext, isWorkMode, normalizeUsage,
  reflectionPrompt, resolveModelRoute,
} from "@kinu.run/core";
import type { OrchestratorAgent } from "./orchestrator";
import {
  type CraftedTool,
  type HeadId,
  type HeadInput,
  type HeadReport,
  type WebSearchProvider,
  type HeadStep,
  type ReportHeadDelta,
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
  type ResolvedTurnProfile,
} from "@kinu.run/core";
import { OwnedModelServices } from "./owned-model-services";
import { FacetIdentity } from "./facet-identity";
import { FacetActivation } from "./facet-activation";
import { createHeadRuntime } from "./head-runtime";
import {
  bindAgentSql, createCFRuntime,
  type CFRuntime, type CFRuntimeHooks, type HostedNodeHome,
} from "./runtime";
import { createExecuteToolsTool } from "./execute-tools";
import { buildHeadToolSet } from "@kinu.run/core";
import {
  createAgentTracing, createConsoleLogger, diagnostics, renderThrownChain, toKinuError,
  type AgentTracing,
} from "@kinu.run/core/obs";
import { createAgentConfigStore, initAgentConfigTable } from "@kinu.run/core";
import { forwardFacetModelOperations } from "./obs/facet-operations";
import { createWorkersTracer } from "./obs/cf-tracer";
import { installAnalyticsDiagnostics } from "./analytics/install";
import { openAnalyticsWindow } from "./analytics/writer";

/**
 * One turn of the conversation a BRANCH is asked to continue from.
 *
 * Named rather than left as an inline `{ role, content }` on the RPC signature: this
 * is a public `@callable` boundary, so the shape is a contract two isolates agree on
 * and the caller's own value is checked against a name rather than against a literal
 * repeated at the call site.
 */
interface PriorTurn {
  readonly role: string;
  readonly content: string;
}

/** One head a recursive split asks for: what it works on, and why it exists. Named
 *  for the same reason {@link PriorTurn} is — it crosses the facet-spawn boundary. */
interface SubheadRequest {
  readonly task: string;
  readonly rationale: string;
}

export class ExplorationAgent extends Agent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    sealRpcSurface(this, EXPLORATION_RPC_SURFACE);
    // Its own isolate, so its own sink — see `ActorAgent`'s constructor. A head,
    // a branch and a swarm node all run in here, and their diagnostics are the
    // only fleet evidence that exploration ran at all.
    installAnalyticsDiagnostics(this.env);
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

  /** What this facet was initialized to RUN, durably. The instance fields above
   *  are the warm path; this is what makes an acked bootstrap survive an
   *  eviction between the init RPC and the run RPC. */
  private readonly activation = new FacetActivation(this.ctx.storage.sql);

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

  /** Where THIS facet's model-operation frames go. The thunk, rather than the
   *  stub: `_cf_initAsFacet` seeds the parent AFTER every field initializer has
   *  run, so a value captured here would be the null it started as. */
  private readonly modelOperations: ModelOperationSink =
    forwardFacetModelOperations(() => this.getSharedParentStub());

  /**
   * The parent workspace's resolved turn profile — the one thing a facet must
   * NOT resolve for itself.
   *
   * Every model a facet builds routes through `MODEL_ROUTE_POLICY`, and the
   * routes it needs split two ways. `mcts`, `head` and `swarm` are `invocation`:
   * the tier the parent's ACTIVE ROLE selected for the turn this work belongs
   * to, which a facet cannot know — it has no role and no turn. The lanes its
   * runtime exposes (`reflection`, `judge`, `fast`, `advisor`) are fixed tiers,
   * which it could read from any envelope, but resolving a second time can
   * still disagree with the first: the provider snapshot moves whenever a
   * credential does, so a facet resolving moments later can land a different
   * `providerRevision` and a different digest. A search whose branches ran
   * under a profile the parent never resolved is unreproducible, which is the
   * reason the digest exists at all.
   *
   * One RPC per activation, memoized on the PROMISE so concurrent lanes share
   * the one round trip rather than racing three. A rejection is not cached: a
   * facet that outlived a transient parent fault would otherwise refuse every
   * later call citing a failure that has already passed.
   */
  private _facetProfile: Promise<ResolvedTurnProfile> | null = null;
  /** Bumped per fetch. A fetch that fails clears the memo only if it is still
   *  the current one, so a stale failure cannot discard a newer fetch. */
  private _facetProfileGeneration = 0;
  private facetProfile(): Promise<ResolvedTurnProfile> {
    if (this._facetProfile) return this._facetProfile;
    const parent = this.getSharedParentStub();
    if (!parent) {
      throw new Error(
        'This facet was spawned without a parent workspace, so it cannot reach the '
        + 'profile that decides its model; setSharedParent must run before it does any model work.',
      );
    }
    const generation = ++this._facetProfileGeneration;
    this._facetProfile = (async (): Promise<ResolvedTurnProfile> => {
      try {
        return await parent.facetTurnProfile();
      } catch (cause) {
        // Dropped rather than kept: a facet that outlived a transient parent
        // fault would otherwise refuse every later call citing a failure that
        // has already passed. The rejection still reaches this call's own
        // caller — only the MEMO is discarded.
        if (this._facetProfileGeneration === generation) this._facetProfile = null;
        diagnostics.failure('facet.turn_profile_unavailable', toKinuError({
          doing: "fetching the parent workspace's resolved turn profile",
          cause,
          otherwise: 'io',
        }), { facet: this.name });
        throw cause;
      }
    })();
    return this._facetProfile;
  }

  /**
   * The spec this facet's work runs on: the one its parent NAMED for it, or the
   * route's when the parent named none.
   *
   * The pin wins deliberately — heterogeneous heads are a real feature, and a
   * search that assigned one head a different model meant it. What changed is
   * the fallback. An absent pin used to reach `resolveModel(null)`, which asks
   * the REGISTRY for the account default and so never consults the profile at
   * all: a role running on any tier but the default had its heads, its nodes and
   * its crafted scripts served by a model it did not select, while its spend was
   * filed against the route that chose differently.
   */
  private async facetModelSpec(
    source: 'head' | 'swarm',
    pinned: string | null | undefined,
  ): Promise<string> {
    if (pinned) return pinned;
    const route = resolveModelRoute(source, await this.facetProfile());
    if (!route) throw new Error(`a facet's ${source} work cannot use the fixed platform model route`);
    return route.model;
  }

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
  private facetRuntime(
    scope: 'head' | 'node',
    hooks: CFRuntimeHooks,
    workspaceExecution?: HostedNodeHome,
  ): CFRuntime {
    const parent = this.getSharedParentStub();
    const workspaceName = this.identity.parentWorkspace();
    if (!parent || !workspaceName) {
      throw new Error(`This ${scope} was spawned without a parent workspace; setSharedParent must run before it can run.`);
    }
    const runtimeHooks: CFRuntimeHooks = {
      ...hooks,
      resolveProfile: () => this.facetProfile(),
    };
    if (workspaceExecution !== undefined) runtimeHooks.workspaceExecution = workspaceExecution;
    return createCFRuntime(this, { env: this.env, ctx: this.ctx }, {
      ownerUserId: () => this.identity.ownerUserId(),
      workspaceName,
      shellId: `${scope}:${this.name}`,
      scaffoldPath: `.kinu/${scope}s/${encodeURIComponent(this.name)}/scaffold/agent.js`,
      capabilityToken: async () => this.identity.capabilityToken(),
    }, runtimeHooks);
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
    this._facetProfile = null;
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
    this._facetProfile = null;
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
   *  the next such number arguable instead of guessed.
   *
   *  The model is the TURN's, resolved through `MODEL_ROUTE_POLICY.mcts` —
   *  `invocation`, so a rollout runs on the same tier the turn that ordered the
   *  search runs on. It used to pass a null spec at a hardcoded `'low'`, which
   *  never consults the profile at all: every branch ran the account default at
   *  an effort nothing chose, so a role on any other tier was searched by models
   *  it had not selected and the comparison was between the wrong things.
   *
   *  Spend is reported by the ENGINE, not here, and deliberately: it returns
   *  `usage` to `mcts/engine.ts`, which files one `mcts` row per branch call
   *  from it (engine.ts:244) because only the engine can tell a completed call
   *  from a rejected or malformed one. A second report here would double-count
   *  every rollout. The OPERATION frame has no such owner — the engine holds no
   *  operation sink and could not open one across the RPC — so it belongs to the
   *  seam that makes the call, which is this one. */
  @callable()
  async explore(
    priorHistory: readonly PriorTurn[],
    craftedTools: CraftedTool[],
    languages: readonly [string, ...string[]],
    mode: WorkMode,
    siblings: readonly string[] = [],
  ): Promise<BranchExploration> {
    // Every work entry on this class reopens the analytics write window. The
    // platform's 250-point budget is per INVOCATION and the constructor's
    // install opens one per ACTIVATION, so a long exploration on a hot facet
    // host spent one budget across the whole run and then went silent — on the
    // rows that are the only fleet evidence exploration ran at all.
    openAnalyticsWindow(this.env);
    if (!isWorkMode(mode)) throw new Error('Branch exploration requires a trusted work mode');
    return await this.tracing.invocation('rpc', 'mcts.branch', async (invocation) => {
      const route = resolveModelRoute('mcts', await this.facetProfile());
      if (!route) throw new Error('an MCTS branch cannot use the fixed platform model route');
      const { model, providerOptions } = this.ownedModelServices.resolveModelWithEffort(
        route.model, route.reasoningEffort,
      );
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
      // Opened BEFORE the request so a branch killed mid-call leaves a start row
      // naming the rollout rather than nothing at all — which is the whole of
      // what `swarm.node_silent` could not distinguish.
      const operation = beginModelOperation(
        { source: 'mcts', operations: this.modelOperations },
        'complete',
        { spec: route.model },
      );
      const { text, usage } = await invocation.span('mcts.branch.model', async (span) => {
        let answer;
        try {
          answer = await generateText(request);
        } catch (cause) {
          operation.failed({ cause });
          throw cause;
        }
        span.setAttribute('kinu.output_tokens', answer.usage.outputTokens ?? 0);
        return answer;
      });
      const normalized = normalizeUsage(usage);
      operation.completed({ usage: normalized, modelId: route.model });

      const trimmed = text.trim();
      void this.sql`INSERT INTO traces (step, text) VALUES (1, ${trimmed})`;
      return { text: trimmed, usage: normalized };
    });
  }

  /** The failure post-mortem for a branch that has already been scored. Same
   *  route, same reporting split and same reason as {@link explore}: `mcts` is
   *  `invocation`, and the engine files this call's spend from the `usage`
   *  returned here (engine.ts:443), so only the operation frame is ours. */
  @callable()
  async generateReflection(task: string, outcome?: string): Promise<BranchReflection> {
    openAnalyticsWindow(this.env);
    const traces = this.sql<{ text: string }>`SELECT text FROM traces ORDER BY step`;
    const route = resolveModelRoute('mcts', await this.facetProfile());
    if (!route) throw new Error('an MCTS reflection cannot use the fixed platform model route');
    const { model, providerOptions } = this.ownedModelServices.resolveModelWithEffort(
      route.model, route.reasoningEffort,
    );
    const request: Parameters<typeof generateText>[0] = {
      model,
      messages: [{
        role: "user" as const,
        content: reflectionPrompt(task, traces.map(t => t.text).join("\n"), outcome),
      }],
    };
    if (providerOptions) request.providerOptions = providerOptions;
    const operation = beginModelOperation(
      { source: 'mcts', operations: this.modelOperations },
      'complete',
      { spec: route.model },
    );
    let result;
    try {
      result = await generateText(request);
    } catch (cause) {
      operation.failed({ cause });
      throw cause;
    }
    const usage = normalizeUsage(result.usage);
    operation.completed({ usage, modelId: route.model });
    return { text: result.text.trim(), usage };
  }

  // ── Head mode @callables  ───────────────────────────────────

  /** Initialize this facet as a branching-heads worker. */
  @callable()
  async initHead(input: HeadInput): Promise<{ ok: true; id: HeadId }> {
    // BEFORE the ack, so an acknowledged bootstrap is a durable one. The
    // instance fields stay as the warm path; the row is what a cold activation
    // reads.
    this.activation.store({ kind: 'head', input });
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
    openAnalyticsWindow(this.env);
    // The stored row is the fallback, not the primary: a warm facet answers from
    // its own field, and only a facet evicted between initHead and here pays the
    // read. Absent from BOTH is a genuine protocol error and still throws.
    const input = this.headInput ?? this.activation.headInput();
    if (!input) throw new Error("ExplorationAgent.runAsHead() called before initHead()");
    return await this.tracing.invocation('rpc', 'head.run', async (invocation, root) => {
      root.setAttribute('kinu.head_id', input.id);
      const capture = new HeadCapture();
      // The loop + report assembly live in core (runHeadInference); the Facet
      // supplies its model + the forked tool surface. Abort is driven by
      // abortHead() flipping this.headAborted.
      const modelSpec = await this.facetModelSpec('head', input.model);
      const headOptions = invocation.span('head.deps', (): Parameters<typeof runHeadInference>[1] => {
        const mission = this.missionScope(input);
        const options: Parameters<typeof runHeadInference>[1] = {
          model: this.ownedModelServices.resolveModel(modelSpec),
          tools: this.buildHeadTools(input, capture),
          capture,
          workspaceLayout: 'shared-workspace',
          isAborted: () => this.headAborted,
          abortReason: () => this.headAbortReason,
        };
        if (mission) options.mission = mission;
        // Null only when this facet has no parent, which is an MCTS branch.
        const parent = this.getSharedParentStub();
        if (parent) {
          options.reportStep = this.stepSink(parent, input.id);
          options.reportDelta = this.deltaSink(parent, input.id);
        }
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
    this.activation.store({ kind: 'node', spec });
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
    openAnalyticsWindow(this.env);
    const spec = this.nodeSpec ?? this.activation.nodeSpec();
    if (!spec) throw new Error("ExplorationAgent.runAsNode() called before initNode()");
    return await this.tracing.invocation('rpc', 'swarm.node', async (invocation, root) => {
      root.setAttribute('kinu.node_id', spec.headInput.id);
      const modelSpec = await this.facetModelSpec('swarm', spec.headInput.model);
      const parent = this.getSharedParentStub();
      if (!parent) {
        throw new Error('This node was spawned without a parent search; setSharedParent must run before runAsNode.');
      }
      const nodeId = spec.headInput.id;
      const workspaceExecution = await invocation.span(
        'swarm.node.home',
        () => parent.resolveHostedNodeHome(nodeId, spec.headInput.rootId, spec.headInput.depth),
      );
      if (workspaceExecution.home !== spec.home) {
        throw new Error(`Node ${nodeId} home differs from the provisioned node spec`);
      }
      const deps = invocation.span('swarm.node.deps', (): NodeLoopDeps => {
        const rt = this.facetRuntime('node', {}, workspaceExecution);
        const webSearch = this.ownedModelServices.getWebSearchProvider();
        const built: NodeLoopDeps = {
          rt,
          model: this.ownedModelServices.resolveModel(modelSpec),
          logger: createConsoleLogger(),
          // The runtime half of the arbitration rule. Its build-time half is
          // `spec.canPropose`, which the search decided: a stub is always non-null, so
          // presence alone cannot answer whether a branch could be granted.
          arbitrate: spec.canPropose ? (proposal) => parent.nodeArbitrate(nodeId, proposal) : null,
          reportStep: this.stepSink(parent, nodeId),
          reportDelta: this.deltaSink(parent, nodeId),
          executeTool: this.facetExecuteTool(rt, webSearch),
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
   * Where this facet's transient frames go: the parent's socket, over the stub it
   * already holds. One sink for a head and a node alike, for the same reason
   * {@link stepSink} is one.
   *
   * NOT AWAITED, and that is the difference from {@link stepSink}. A step is the
   * branch's durable record and the next request must not be issued while it is
   * in flight; a frame is a repaint. One frame is one provider delta, so awaiting
   * would put the model's own stream behind a cross-isolate round trip per delta
   * — paid for nothing, since the step that lands afterwards states the same
   * text.
   *
   * A rejection is therefore reported and dropped. The client is corrected by the
   * `head_activity` the parent sends when this step lands, so a channel that has
   * gone quiet costs a stale pane and never the run.
   */
  private deltaSink(
    parent: DurableObjectStub<OrchestratorAgent>,
    headId: HeadId,
  ): ReportHeadDelta {
    return (kind, delta) => {
      // NOT AWAITED, and not a `.catch` with an annotated thrown parameter either:
      // the catch BINDING is where a thrown value is narrowed in this repo, and
      // `renderThrownChain` is the one reader of it. A frame is a repaint, so a
      // parent gone quiet costs a stale pane and never the run.
      void (async () => {
        try {
          await parent.publishHeadStream(headId, kind, delta);
        } catch (cause) {
          diagnostics.event('head.stream_frame_dropped', {
            headId,
            reason: renderThrownChain({ cause }),
          });
        }
      })().catch((cause: unknown) => {
        // The only statement this body runs outside the try is the IIFE's own
        // exit, so a rejection here means the handler itself threw. Recorded at
        // lane level: a broken sink must not masquerade as a dropped frame.
        diagnostics.failure('head.stream_sink_failed', toKinuError({
          doing: 'reporting that a head stream frame was dropped',
          cause,
          otherwise: 'unavailable',
        }), { headId });
      });
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
      executeTool: this.facetExecuteTool(rt, webSearch),
      webSearch,
      split: (request) => this.runRecursiveSplit(request, input.budget, input),
    });
  }

  /** The `execute_tools` surface a facet's mode gets over its own runtime. ONE
   *  builder for a head and a node: they differ in nothing this tool can see,
   *  now that a crafted script has no model of its own to call. */
  private facetExecuteTool(rt: CFRuntime, webSearch: WebSearchProvider) {
    return createExecuteToolsTool({
      loader: this.env.LOADER,
      rt,
      sql: this.boundSql,
      webSearch,
    });
  }

  // ── Recursive split — head spawns more heads (itself ExplorationAgent facets)
  private async runRecursiveSplit(
    request: {
      readonly rationale: string;
      readonly heads: readonly SubheadRequest[];
      readonly mergeStrategy: MergeStrategy;
    },
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
      // The merge resolves `judge` — the account-wide deep tier — off this
      // profile. It used to pass `parentInput.model`, so a synthesis filed as
      // deep-tier grading ran on whatever model the head itself was given.
      profile: () => this.facetProfile(),
      // Reported to the root over the same cross-DO port the journal above uses,
      // because that is where the workspace's total is assembled.
      reportModelCall: (report) => {
        void parent.reportFacetModelCall(report).catch((cause: unknown) => {
          diagnostics.failure('event.model_call_emit_failed', toKinuError({
            doing: 'forwarding a model_call report to the root workspace',
            cause,
            otherwise: 'io',
          }), { source: report.source });
        });
      },
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
      request: { rationale: request.rationale, heads: [...request.heads], mergeStrategy: request.mergeStrategy },
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
