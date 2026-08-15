/**
 * ExplorationAgent — the parallel sub-agent Facet.
 *
 * One class, two modes — and the difference between them is the whole point:
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
 *               is declared in @proteus/core head-tools.
 *
 * Both modes share: Facet class, composed owner/model services, lifecycle,
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

import { Agent, callable, type AgentContext } from "agents";
import { EXPLORATION_RPC_SURFACE, sealRpcSurface } from "./rpc-surface.js";
import { generateText } from "ai";
import { explorePrompt, formatInheritedContext, generateJson, isWorkMode, missionCallUsage, parseModelSpec, reasoningEffortOptions, reflectionPrompt, resolveMaxSteps } from "@proteus/core";
import type { OrchestratorAgent } from "./orchestrator.js";
import {
  type CraftedTool,
  type HeadId,
  type HeadInput,
  type HeadReport,
  type HeadRuntime,
  type Decision,
  type MergeStrategy,
  type HeadBudget,
  type MergeResult,
  type SqlExecutor,
  initHeadsTables,
  HeadController,
  HeadJournal,
  MergeOutputSchema,
  type MergeOutput,
  type BranchExploration,
  type BranchReflection,
  HeadCapture,
  runHeadInference,
  type MissionScope,
  type WorkMode,
} from "@proteus/core";
import { OwnedModelServices } from "./owned-model-services.js";
import { spawnHeadFacet } from "./facet-spawn.js";
import { bindAgentSql, createCFRuntime, type CFRuntime } from "./runtime.js";
import { createExecuteToolsTool } from "./execute-tools.js";
import { buildHeadToolSet } from "@proteus/core";

export class ExplorationAgent extends Agent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    sealRpcSurface(this, EXPLORATION_RPC_SURFACE);
  }

  // ── Head-mode state (MCTS mode is stateless beyond the traces table) ──
  private headInput: HeadInput | null = null;
  private headAborted = false;
  private headAbortReason: string | null = null;

  private readonly ownedModelServices = new OwnedModelServices({
    env: this.env,
    agentName: () => this.name,
    appTitle: 'Proteus (exploration)',
    ownerRequired: false,
    getOwnerUserId: () => this.getOwnerUserId(),
    getUserCaller: async () => {
      const workspaceToken = this.getCapabilityToken();
      if (!workspaceToken) throw new Error('This exploration facet was seeded without a workspace capability token.');
      return { workspaceToken };
    },
  });

  private resolveLowEffortModel(spec?: string | null) {
    const registry = this.ownedModelServices.providerRegistry();
    const normalizedSpec = registry.normalizeSpecSync(spec);
    return {
      model: registry.resolveModel(normalizedSpec),
      providerOptions: reasoningEffortOptions('low', parseModelSpec(normalizedSpec).provider),
    };
  }

  private get boundSql(): SqlExecutor {
    return bindAgentSql(this);
  }

  /** A head has private SQL ledgers and shell state, but not another workspace.
   * Its canonical file plane is wrapped with this run's observer before tools
   * are built, so writes are attributable without another executor or VFS. */
  private headRuntime(capture: HeadCapture): CFRuntime {
    const parent = this.getSharedParentStub();
    const workspaceName = this.getSharedParent();
    if (!parent || !workspaceName) {
      throw new Error('This head was spawned without a parent workspace; setSharedParent must run before runAsHead.');
    }
    return createCFRuntime(this, { env: this.env, ctx: this.ctx }, {
      ownerUserId: () => this.getOwnerUserId(),
      workspaceName,
      shellId: `head:${this.name}`,
      scaffoldPath: `.proteus/heads/${encodeURIComponent(this.name)}/scaffold/agent.js`,
      capabilityToken: async () => this.getCapabilityToken(),
    }, { workspaceObserver: capture.files });
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
    this.ensureFacetOwnerTable();
    this.ctx.storage.sql.exec(
      `INSERT INTO facet_owner (id, user_id, capability_token) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, capability_token = excluded.capability_token`,
      userId, capabilityToken,
    );
    this.ownedModelServices.invalidate();
    return { ok: true };
  }

  private ensureFacetOwnerTable(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS facet_owner (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         user_id TEXT NOT NULL,
         capability_token TEXT
       )`,
    );
    const columns = sql.exec(`PRAGMA table_info(facet_owner)`).toArray();
    if (!columns.some((c) => c.name === 'capability_token')) {
      sql.exec(`ALTER TABLE facet_owner ADD COLUMN capability_token TEXT`);
    }
  }

  /** Migrate on READ as well as on write: a facet seeded before the token
   *  column existed and resumed without a fresh setOwner would otherwise lose
   *  its OWNER too, not merely its token, on the missing-column error. */
  private facetOwnerRow(): { user_id: string; capability_token: string | null } | null {
    try {
      this.ensureFacetOwnerTable();
      const rows = this.ctx.storage.sql.exec<{ user_id: string; capability_token: string | null }>(
        `SELECT user_id, capability_token FROM facet_owner WHERE id = 1`,
      ).toArray();
      return rows[0] ?? null;
    } catch { return null; }
  }

  private getOwnerUserId(): string | null {
    return this.facetOwnerRow()?.user_id ?? null;
  }

  private getCapabilityToken(): string | null {
    return this.facetOwnerRow()?.capability_token ?? null;
  }

  /** The ROOT workspace this head forks: whose canonical Nimbus session and
   *  execution planes it shares, and where the whole split's findings accumulate.
   *  Set by the spawner right after subAgent() and propagated UNCHANGED to
   *  recursive sub-heads, so an intermediate head never becomes the tree's
   *  workspace. Persisted for hibernation. */
  @callable()
  async setSharedParent(agentName: string): Promise<{ ok: true }> {
    if (!agentName) throw new Error('agentName required');
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS facet_parent (id INTEGER PRIMARY KEY CHECK (id = 1), agent_name TEXT NOT NULL)`,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO facet_parent (id, agent_name) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET agent_name = excluded.agent_name`,
      agentName,
    );
    return { ok: true };
  }

  private getSharedParent(): string | null {
    try {
      const rows = this.ctx.storage.sql.exec<{ agent_name: string }>(
        `SELECT agent_name FROM facet_parent WHERE id = 1`,
      ).toArray();
      return rows[0]?.agent_name ?? null;
    } catch { return null; }
  }

  /** Stub to the root workspace orchestrator — the head's parent — or null if
   *  unset (an MCTS branch never has one). */
  private getSharedParentStub(): DurableObjectStub<OrchestratorAgent> | null {
    const name = this.getSharedParent();
    if (!name) return null;
    return this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(name));
  }

  async onStart() {
    // MCTS mode trace table — pre-existing.
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

  @callable()
  async explore(
    priorHistory: Array<{ role: string; content: string }>,
    craftedTools: CraftedTool[],
    languages: readonly [string, ...string[]],
    mode: WorkMode,
    siblings: readonly string[] = [],
  ): Promise<BranchExploration> {
    if (!isWorkMode(mode)) throw new Error('Branch exploration requires a trusted work mode');
    const { model, providerOptions } = this.resolveLowEffortModel();
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
    const { text, usage } = await generateText(request);

    const trimmed = text.trim();
    void this.sql`INSERT INTO traces (step, text) VALUES (1, ${trimmed})`;
    return { text: trimmed, usage: missionCallUsage(usage) };
  }

  @callable()
  async generateReflection(task: string): Promise<BranchReflection> {
    const traces = this.sql<{ text: string }>`SELECT text FROM traces ORDER BY step`;
    const { model, providerOptions } = this.resolveLowEffortModel();
    const request: Parameters<typeof generateText>[0] = {
      model,
      messages: [{
        role: "user" as const,
        content: reflectionPrompt(task, traces.map(t => t.text).join("\n")),
      }],
    };
    if (providerOptions) request.providerOptions = providerOptions;
    const { text, usage } = await generateText(request);
    return { text: text.trim(), usage: missionCallUsage(usage) };
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
   *  declared in @proteus/core head-tools. */
  @callable()
  async runAsHead(): Promise<HeadReport> {
    if (!this.headInput) throw new Error("ExplorationAgent.runAsHead() called before initHead()");
    const input = this.headInput;
    const capture = new HeadCapture();
    // The loop + report assembly live in core (runHeadInference); the Facet
    // supplies its model + the forked tool surface. Abort is driven by
    // abortHead() flipping this.headAborted.
    const mission = this.missionScope(input);
    const options: Parameters<typeof runHeadInference>[1] = {
      model: this.ownedModelServices.resolveModel(input.model),
      tools: this.buildHeadTools(input, capture),
      capture,
      workspaceLayout: 'shared-workspace',
      // The same envelope the parent turn runs to — ActorAgent.maxSteps reads
      // this identical Worker var. A fork of a turn gets the turn's room.
      maxSteps: resolveMaxSteps(this.env.PROTEUS_MAX_STEPS),
      isAborted: () => this.headAborted,
      abortReason: () => this.headAbortReason,
    };
    if (mission) options.mission = mission;
    return runHeadInference(input, options);
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
    return buildHeadToolSet({
      input,
      capture,
      rt,
      executeTool: createExecuteToolsTool({
        loader: this.env.LOADER,
        rt,
        sql: this.boundSql,
        registry: this.ownedModelServices.providerRegistry(),
        modelSpec: () => input.model ?? null,
        webSearch: this.ownedModelServices.getWebSearchProvider(),
      }),
      webSearch: this.ownedModelServices.getWebSearchProvider(),
      split: (request) => this.runRecursiveSplit(request, input.budget, input),
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
    // Ensure the journal tables exist on THIS facet's storage so recursive
    // splits can persist locally without competing with the orchestrator. Single
    // source of truth — same schema the orchestrator initializes.
    initHeadsTables((ddl: string) => { this.ctx.storage.sql.exec(ddl); });

    const journal = new HeadJournal(this.boundSql);
    const runtime: HeadRuntime = {
      spawnHead: (childInput: HeadInput) => {
        return spawnHeadFacet(this, childInput, {
          ownerUserId: this.getOwnerUserId(),
          capabilityToken: this.getCapabilityToken(),
          // The ROOT orchestrator, propagated unchanged so the whole subtree
          // shares one findings scratch (not this intermediate head).
          sharedParent: this.getSharedParent(),
        });
      },
      mergeLLM: async (prompt: string): Promise<MergeOutput> => {
        const { model, providerOptions } = this.resolveLowEffortModel(parentInput.model);
        const options: Parameters<typeof generateJson<MergeOutput>>[0] = {
          model,
          schema: MergeOutputSchema,
          prompt,
        };
        if (providerOptions) options.providerOptions = providerOptions;
        return generateJson(options);
      },
    };

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
  // core (runHeadInference); the tool surface lives in @proteus/core head-tools. This
  // Facet supplies the three things only it can: the model, the forked runtime,
  // and the facet-spawn substrate behind split_subheads.
}
