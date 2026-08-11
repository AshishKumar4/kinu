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
 *               runAsHead() / abortHead() drive an agentic loop over a FORK of
 *               the parent workspace: the parent's sandbox container, Nimbus
 *               session and device consent, with the parent's workspace files
 *               mounted at /workspace (see headRuntime()). Its tool surface —
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
import { explorePrompt, extractCodeBlock, formatInheritedContext, generateJson, parseModelSpec, reasoningEffortOptions, reflectionPrompt, resolveMaxSteps } from "@proteus/core";
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
  type ParentRpcFileHandle,
  type SqlExecutor,
  createParentRpcMountVFS,
  initHeadsTables,
  HeadController,
  HeadJournal,
  MergeOutputSchema,
  type MergeOutput,
  HeadCapture,
  runHeadInference,
  type MissionScope,
} from "@proteus/core";
import { OwnedModelServices } from "./owned-model-services.js";
import { spawnHeadFacet } from "./facet-spawn.js";
import { createCFRuntime, type CFRuntime } from "./runtime.js";
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
    return this.sql.bind(this) as unknown as SqlExecutor;
  }

  /**
   * The head's runtime — a FORK of the parent workspace's, built lazily because
   * only head mode has one (see the class docstring for why MCTS mode must not).
   *
   * Forked, not fresh: `workspaceName` is the PARENT's, so every exec plane the
   * runtime keys off it — the `proteus-<workspace>` sandbox container, the
   * Nimbus session, the /pc device consent, the Vectorize namespace — resolves
   * to the same plane the parent agent works in. This is exactly how a
   * SubordinateAgent rides its parent (subordinate-agent.ts workspaceName), and
   * the reason ActorRuntimeIdentity separates "who I am" from "whose exec planes
   * I ride" at all.
   *
   * Storage stays this facet's own, so `/local` is a private scratch siblings
   * can't see; the parent's durable workspace files arrive as the `/workspace`
   * mount over the same parent RPC handle subordinates use.
   */
  private _headRt: CFRuntime | null = null;
  private headRuntime(): CFRuntime {
    if (this._headRt) return this._headRt;
    const parent = this.getSharedParentStub();
    const workspaceName = this.getSharedParent();
    if (!parent || !workspaceName) {
      throw new Error('This head was spawned without a parent workspace; setSharedParent must run before runAsHead.');
    }
    const rt = createCFRuntime(this as unknown as Parameters<typeof createCFRuntime>[0], {
      ownerUserId: () => this.getOwnerUserId(),
      workspaceName,
      capabilityToken: async () => this.getCapabilityToken(),
    });
    const handle: ParentRpcFileHandle = {
      read: (path) => parent.readWorkspaceFile(path),
      write: (input) => parent.writeWorkspaceFile(input),
      list: (path) => parent.listWorkspaceFiles(path),
      stat: (path) => parent.statWorkspaceFile(path),
      delete: (path) => parent.deleteWorkspaceFile(path),
    };
    rt.compositeVfs.mount('workspace', {
      vfs: createParentRpcMountVFS(handle),
      policy: {
        readOnly: false,
        rootPath: '',
        consistency: 'durable',
      },
    });
    this._headRt = rt;
    return rt;
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
      const rows = this.ctx.storage.sql.exec(
        `SELECT user_id, capability_token FROM facet_owner WHERE id = 1`,
      ).toArray() as Array<{ user_id: string; capability_token: string | null }>;
      return rows[0] ?? null;
    } catch { return null; }
  }

  private getOwnerUserId(): string | null {
    return this.facetOwnerRow()?.user_id ?? null;
  }

  private getCapabilityToken(): string | null {
    return this.facetOwnerRow()?.capability_token ?? null;
  }

  /** The ROOT workspace this head forks: whose exec planes it rides, whose files
   *  it mounts at /workspace, and where the whole split's findings accumulate.
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
      const rows = this.ctx.storage.sql.exec(
        `SELECT agent_name FROM facet_parent WHERE id = 1`,
      ).toArray() as Array<{ agent_name: string }>;
      return rows[0]?.agent_name ?? null;
    } catch { return null; }
  }

  /** Stub to the root workspace orchestrator — the head's parent — or null if
   *  unset (an MCTS branch never has one). */
  private getSharedParentStub(): DurableObjectStub<OrchestratorAgent> | null {
    const name = this.getSharedParent();
    if (!name) return null;
    return this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(name)) as DurableObjectStub<OrchestratorAgent>;
  }

  async onStart() {
    // MCTS mode trace table — pre-existing.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(9)))),
        step       INTEGER NOT NULL,
        text       TEXT NOT NULL,
        code_used  TEXT,
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
    siblings: readonly string[] = [],
  ): Promise<{ text: string; codeUsed: string | null }> {
    const { model, providerOptions } = this.resolveLowEffortModel();
    const { system, user } = explorePrompt({
      context: formatInheritedContext(priorHistory),
      craftedTools,
      siblings,
    });

    const { text } = await generateText({
      model,
      system,
      messages: [{ role: "user" as const, content: user }],
      ...(providerOptions ? { providerOptions } : {}),
    });

    const trimmed = text.trim();
    const codeUsed = extractCodeBlock(trimmed);
    this.sql`INSERT INTO traces (step, text, code_used) VALUES (1, ${trimmed}, ${codeUsed})`;
    return { text: trimmed, codeUsed };
  }

  @callable()
  async generateReflection(task: string): Promise<string> {
    const traces = this.sql<{ text: string }>`SELECT text FROM traces ORDER BY step`;
    const { model, providerOptions } = this.resolveLowEffortModel();
    const { text } = await generateText({
      model,
      messages: [{
        role: "user" as const,
        content: reflectionPrompt(task, traces.map(t => t.text).join("\n")),
      }],
      ...(providerOptions ? { providerOptions } : {}),
    });
    return text.trim();
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
    return runHeadInference(input, {
      model: this.ownedModelServices.resolveModel(input.model),
      tools: this.buildHeadTools(input, capture),
      capture,
      // The same envelope the parent turn runs to — ActorAgent.maxSteps reads
      // this identical Worker var. A fork of a turn gets the turn's room.
      maxSteps: resolveMaxSteps(this.env.PROTEUS_MAX_STEPS),
      isAborted: () => this.headAborted,
      abortReason: () => this.headAbortReason,
      ...(mission ? { mission } : {}),
    });
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
    const rt = this.headRuntime();
    return buildHeadToolSet({
      input,
      capture,
      rt,
      executeTool: createExecuteToolsTool({
        loader: (this.env as Env & Record<string, unknown>).LOADER,
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
    childHeadIds: readonly HeadId[];
    headCount: number;
  }> {
    // Ensure the journal tables exist on THIS facet's storage so recursive
    // splits can persist locally without competing with the orchestrator. Single
    // source of truth — same schema the orchestrator initializes.
    initHeadsTables((ddl: string) => { this.ctx.storage.sql.exec(ddl); });

    const journal = new HeadJournal(this.boundSql);
    const facet = this;
    const runtime: HeadRuntime = {
      spawnHead(childInput: HeadInput) {
        return spawnHeadFacet(facet, childInput, {
          ownerUserId: facet.getOwnerUserId(),
          capabilityToken: facet.getCapabilityToken(),
          // The ROOT orchestrator, propagated unchanged so the whole subtree
          // shares one findings scratch (not this intermediate head).
          sharedParent: facet.getSharedParent(),
        });
      },
      async mergeLLM(prompt: string): Promise<MergeOutput> {
        const { model, providerOptions } = facet.resolveLowEffortModel(parentInput.model);
        return generateJson({
          model,
          schema: MergeOutputSchema,
          prompt,
          ...(providerOptions ? { providerOptions } : {}),
        });
      },
    };

    const controller = new HeadController(runtime, journal);
    const result: MergeResult = await controller.run({
      parentHeadId: parentInput.id,
      rootId: parentInput.rootId,
      inheritedContext: parentInput.inheritedContext,
      request: { rationale: request.rationale, heads: request.heads, mergeStrategy: request.mergeStrategy },
      parentBudget,
      model: parentInput.model,
      // A subtree charges the same mission its root does — otherwise a head
      // escapes its budget simply by splitting again.
      ...(parentInput.missionLabels?.length ? { missionLabels: parentInput.missionLabels } : {}),
    });

    return {
      narrative: result.mergedNarrative,
      decisions: result.selectedDecisions,
      unresolvedQuestions: result.unresolvedQuestions,
      childHeadIds: result.headIds,
      headCount: result.costSummary.headCount,
    };
  }

  // The head loop, system prompt, inherited context and report assembly live in
  // core (runHeadInference); the tool surface lives in @proteus/core head-tools. This
  // Facet supplies the three things only it can: the model, the forked runtime,
  // and the facet-spawn substrate behind split_subheads.
}
