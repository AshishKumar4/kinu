/**
 * ExplorationAgent — the parallel sub-agent Facet.
 *
 * One class, two modes:
 *
 *   MCTS mode  (existing) — short-form one-shot rollouts used by the MCTS
 *                           engine. @callable explore() returns a single
 *                           text + optional code; @callable evaluate()
 *                           judges the accumulated trace; generateReflection
 *                           produces a failure post-mortem.
 *
 *   HEAD mode         — long-form multi-step inference used by the
 *                           branching-heads primitive (think strategy=heads).
 *                           @callable init() / runAsHead() / abort() drive
 *                           an agentic loop with a restricted tool surface
 *                           (record_evidence, record_decision, sandbox_*).
 *                           Each head gets its own ephemeral SqliteFS +
 *                           virtual-bash for scratch work; siblings can't
 *                           see each other.
 *
 * Both modes share: Facet class, getModel() helper, lifecycle, parallel-
 * spawn infrastructure (rt.spawnBranch). No separate `HeadAgent` class.
 *
 * Constraints (Agent SDK facets):
 *   • schedule(), keepAlive(), runFiber() all throw in facets
 *   • Own SQLite — independent from the orchestrator's
 *   • LLM config derived per-call from env.AI / AI_GATEWAY_*
 */

import { Agent, callable } from "agents";
import { generateText, tool, jsonSchema } from "ai";
import type { LanguageModel } from "ai";
import { createAgentProviderRegistry, type AgentProviderRegistry } from "./providers/agent-registry.js";
import { agentAffinityKey } from "./providers/workers-ai.js";
import { generateJson } from "./lib/generate-json.js";
import type { UserDO } from "./user/user-do.js";
import type { OrchestratorAgent } from "./orchestrator.js";
import {
  type CraftedTool,
  type HeadId,
  type HeadInput,
  type HeadReport,
  type Decision,
  type MergeStrategy,
  type HeadBudget,
  type MergeResult,
  budgetExhausted,
  initHeadsTables,
  HeadController,
  HeadJournal,
  MergeOutputSchema,
  type MergeOutput,
  HeadCapture,
  runHeadInference,
  buildHeadAccumulatorTools,
  buildHeadSandboxTools,
} from "@proteus/core";
import { SqliteFS } from "@proteus/agent-utils/vfs";
import { createShell, type ShellResult } from "@proteus/agent-utils/shell";
import type { SqlExecutor } from "@proteus/agent-utils";

export class ExplorationAgent extends Agent<Env> {
  // ── MCTS-mode state (pre-existing) ──────────────────────────────

  // ── Head-mode state  ────────────────────────────────────────
  private headInput: HeadInput | null = null;
  // Per-head findings accumulator — built fresh in runAsHead, mutated by the
  // head's scratch tools, read into the HeadReport by core runHeadInference.
  private headCapture: HeadCapture | null = null;
  private headAborted = false;
  private headAbortReason: string | null = null;

  // Lazy per-facet VFS + shell — only built when head mode runs.
  private _vfs: SqliteFS | null = null;
  private _shell: { exec(input: string, stdin?: string): Promise<ShellResult> } | null = null;
  private getHeadVfs(): SqliteFS {
    if (this._vfs) return this._vfs;
    const sql = this.sql.bind(this) as unknown as SqlExecutor;
    this._vfs = new SqliteFS(sql);
    this._vfs.init();
    return this._vfs;
  }
  private getHeadShell() {
    if (this._shell) return this._shell;
    this._shell = createShell(this.getHeadVfs());
    return this._shell;
  }

  private _providerRegistry: AgentProviderRegistry | null = null;
  private providerRegistry(): AgentProviderRegistry {
    if (this._providerRegistry) return this._providerRegistry;
    const userId = this.getOwnerUserId();
    const userDOStub = userId
      ? (this.env.UserDO.get(this.env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>)
      : null;
    this._providerRegistry = createAgentProviderRegistry({
      env: this.env,
      userDOStub,
      appTitle: 'Proteus (exploration)',
      workersAI: { sessionAffinity: agentAffinityKey(this.name) },
    });
    return this._providerRegistry;
  }

  /** ExplorationAgents inherit ownership from the orchestrator that spawned
   *  them; the parent calls setOwner immediately after subAgent() returns
   *  the stub. Persisted to SQL so hibernation between spawn + run is safe. */
  @callable()
  async setOwner(userId: string): Promise<{ ok: true }> {
    if (!userId) throw new Error('userId required');
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS facet_owner (id INTEGER PRIMARY KEY CHECK (id = 1), user_id TEXT NOT NULL)`,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO facet_owner (id, user_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id`,
      userId,
    );
    this._providerRegistry = null;   // rebuild against the new owner
    return { ok: true };
  }

  private getOwnerUserId(): string | null {
    try {
      const rows = this.ctx.storage.sql.exec(
        `SELECT user_id FROM facet_owner WHERE id = 1`,
      ).toArray() as Array<{ user_id: string }>;
      return rows[0]?.user_id ?? null;
    } catch { return null; }
  }

  /** The ROOT orchestrator agent name — the shared point every head in a split
   *  writes findings to (shared/findings/ in its workspace VFS). Set by the
   *  spawner right after subAgent(); propagated unchanged to recursive sub-heads
   *  so the whole tree shares ONE common scratch. Persisted for hibernation. */
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

  /** Stub to the root orchestrator for shared-scratch RPCs, or null if unset. */
  private getSharedParentStub(): DurableObjectStub<OrchestratorAgent> | null {
    const name = this.getSharedParent();
    if (!name) return null;
    return this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(name)) as DurableObjectStub<OrchestratorAgent>;
  }

  /** Resolve the LanguageModel for this facet. `modelId` is whatever the
   *  parent passed (could be a bare modelId or a full spec); the registry
   *  normalizes it (handles BC `@cf/...` form). */
  getModel(modelId?: string): LanguageModel {
    const reg = this.providerRegistry();
    return reg.resolveModel(reg.normalizeSpecSync(modelId));
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

  // ── MCTS mode @callables (unchanged) ────────────────────────────

  @callable()
  async explore(
    priorHistory: Array<{ role: string; content: string }>,
    craftedTools: CraftedTool[],
  ): Promise<{ text: string; codeUsed: string | null }> {
    const model = this.getModel();
    const context = priorHistory.map(m => `${m.role}: ${m.content}`).join("\n").slice(-2000);
    const toolHints = craftedTools.length > 0
      ? `\nKnown patterns:\n${craftedTools.map(t => `- ${t.name}: ${t.description}`).join("\n")}`
      : "";

    const { text } = await generateText({
      model,
      system: "You are an expert agent exploring one approach to solve a task." + toolHints +
        "\n\nIf your approach involves code, include it in a ```js code block.",
      messages: [{ role: "user" as const, content: `Prior context:\n${context}\n\nPropose ONE specific concrete approach. Include a code implementation if applicable.` }],
      maxOutputTokens: 4096,
    });

    const trimmed = text.trim();
    const codeMatch = trimmed.match(/```(?:js|javascript|typescript|ts)?\n([\s\S]*?)```/);
    const codeUsed = codeMatch?.[1]?.trim() ?? null;
    this.sql`INSERT INTO traces (step, text, code_used) VALUES (1, ${trimmed}, ${codeUsed})`;
    return { text: trimmed, codeUsed };
  }

  @callable()
  async evaluate(task: string): Promise<number> {
    const traces = this.sql<{ text: string }>`SELECT text FROM traces ORDER BY step`;
    const trajectory = traces.map(t => t.text).join("\n---\n");

    const model = this.getModel();
    const { text } = await generateText({
      model,
      messages: [{
        role: "user" as const,
        content: `Task: ${task}\n\nTrajectory:\n${trajectory.slice(0, 2000)}\n\nRate 0.0-1.0. Respond ONLY: {"score": <float>, "reason": "<5 words>"}`,
      }],
      maxOutputTokens: 100,
    });

    try {
      const m = text.match(/\{[^}]+\}/);
      const parsed = JSON.parse(m?.[0] ?? '{"score":0.5}');
      return Math.min(1, Math.max(0, Number(parsed.score) || 0.5));
    } catch {
      return 0.5;
    }
  }

  @callable()
  async generateReflection(task: string): Promise<string> {
    const traces = this.sql<{ text: string }>`SELECT text FROM traces ORDER BY step`;
    const model = this.getModel();
    const { text } = await generateText({
      model,
      messages: [{
        role: "user" as const,
        content: `Task: ${task}\nAttempt: ${traces.map(t => t.text).join("\n")}\n\nWhat specifically went wrong? One sentence.`,
      }],
      maxOutputTokens: 200,
    });
    return text.trim();
  }

  // ── Head mode @callables  ───────────────────────────────────

  /** Initialize this facet as a branching-heads worker. */
  @callable()
  async initHead(input: HeadInput): Promise<{ ok: true; id: HeadId }> {
    this.headInput = input;
    this.headCapture = null;   // built fresh in runAsHead
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

  /**
   * Run the head's inference loop. Returns the final HeadReport.
   *
   * Restricted ToolSet:
   *   record_evidence / record_decision  — accumulate findings
   *   sandbox_exec / read / write / list — own ephemeral VFS+shell
   *   split_subheads                     — recursive split (depth-budgeted)
   */
  @callable()
  async runAsHead(): Promise<HeadReport> {
    if (!this.headInput) throw new Error("ExplorationAgent.runAsHead() called before initHead()");
    const input = this.headInput;
    const capture = new HeadCapture();
    this.headCapture = capture;
    // The loop + report assembly live in core (runHeadInference); the Facet
    // supplies its model + scratch tools (sandbox/shared/recursive-split). Abort
    // is driven by abortHead() flipping this.headAborted.
    return runHeadInference(input, {
      model: this.getModel(input.model),
      tools: this.buildHeadTools(input, capture),
      capture,
      isAborted: () => this.headAborted,
      abortReason: () => this.headAbortReason,
    });
  }

  // ── Head-mode tool builders ─────────────────────────────────────

  private buildHeadTools(input: HeadInput, capture: HeadCapture) {
    const allowedToolNames = new Set(input.allowedTools ?? []);
    const isAllowed = (name: string) => input.allowedTools === undefined || allowedToolNames.has(name);

    const facet = this;
    const shell = this.getHeadShell();
    const vfs = this.getHeadVfs();

    const all = {
      // record_evidence / record_decision — shared core accumulator tools.
      ...buildHeadAccumulatorTools(capture),

      // sandbox_exec / read / write / list — shared core sandbox tools over this
      // Facet's own ephemeral SqliteFS + virtual shell.
      ...buildHeadSandboxTools(shell, vfs, capture),

      shared_write: tool({
        description:
          "Write a finding to the SHARED agent-level scratch (visible to sibling heads AND the main agent at `shared/findings/`). Use for results worth sharing across heads — your sandbox_* files stay private to you. Your writes are namespaced by head, so siblings can't clobber them.",
        inputSchema: jsonSchema<{ path: string; content: string }>({
          type: "object", required: ["path", "content"],
          properties: { path: { type: "string" }, content: { type: "string" } },
        }),
        execute: async ({ path, content }) => {
          const stub = facet.getSharedParentStub();
          if (!stub) { capture.recordToolCall("shared_write", { path }, "no-parent"); return "shared scratch unavailable (no parent agent set)"; }
          try {
            const r = await stub.sharedScratchWrite(input.id, path, content);
            capture.recordArtifact({ kind: "file", ref: r.path, description: `shared finding (${content.length}b)` });
            capture.recordToolCall("shared_write", { path, contentLen: content.length }, "ok");
            return `wrote shared finding → ${r.path}`;
          } catch (err) {
            capture.recordToolCall("shared_write", { path }, "error");
            return `shared write error: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      }),

      shared_read: tool({
        description: "Read a finding from the shared agent-level scratch (path relative to `shared/findings/`, e.g. another head's `<headId>/notes.md`). Use shared_list to discover paths.",
        inputSchema: jsonSchema<{ path: string }>({
          type: "object", required: ["path"], properties: { path: { type: "string" } },
        }),
        execute: async ({ path }) => {
          const stub = facet.getSharedParentStub();
          if (!stub) return "shared scratch unavailable (no parent agent set)";
          try {
            const c = await stub.sharedScratchRead(path);
            capture.recordToolCall("shared_read", { path }, c == null ? "missing" : "ok");
            return c ?? `(no shared finding at ${path})`;
          } catch (err) {
            capture.recordToolCall("shared_read", { path }, "error");
            return `shared read error: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      }),

      shared_list: tool({
        description: "List all findings currently in the shared agent-level scratch (paths relative to `shared/findings/`, across every head).",
        inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
        execute: async () => {
          const stub = facet.getSharedParentStub();
          if (!stub) return "shared scratch unavailable (no parent agent set)";
          try {
            const paths = await stub.sharedScratchList();
            capture.recordToolCall("shared_list", {}, `${paths.length} files`);
            return paths.length ? paths.join("\n") : "(shared scratch is empty)";
          } catch (err) {
            capture.recordToolCall("shared_list", {}, "error");
            return `shared list error: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      }),

      split_subheads: tool({
        description:
          "Spawn 2-4 child heads recursively to explore narrower sub-questions. " +
          "Children's findings merge into a single narrative. May fail if depth exhausted.",
        inputSchema: jsonSchema<{
          rationale: string;
          heads: Array<{ task: string; rationale: string }>;
          merge_strategy?: MergeStrategy;
        }>({
          type: "object", required: ["rationale", "heads"],
          properties: {
            rationale: { type: "string" },
            heads: {
              type: "array", minItems: 2, maxItems: 4,
              items: {
                type: "object", required: ["task", "rationale"],
                properties: { task: { type: "string" }, rationale: { type: "string" } },
              },
            },
            merge_strategy: { type: "string", enum: ["synthesize", "best_of", "consensus"] },
          },
        }),
        execute: async ({ rationale, heads, merge_strategy }): Promise<string> => {
          const bExh = budgetExhausted(input.budget);
          if (bExh.exhausted) return `Cannot split: budget exhausted (${bExh.reason}).`;
          if (input.budget.maxDepth <= 0) return "Cannot split: maxDepth budget reached.";
          try {
            const result = await facet.runRecursiveSplit(
              { rationale, heads, mergeStrategy: merge_strategy ?? input.mergeStrategy },
              input.budget, input,
            );
            for (const cid of result.childHeadIds) capture.childHeadIds.push(cid);
            capture.recordToolCall("split_subheads", { rationale, heads }, `merged ${result.headCount}`);
            const lines: string[] = [result.narrative];
            if (result.decisions.length) {
              lines.push("", "Children's selected decisions:");
              for (const d of result.decisions) lines.push(`- ${d.question}: ${d.choice}`);
            }
            if (result.unresolvedQuestions.length) {
              lines.push("", "Open questions:");
              for (const q of result.unresolvedQuestions) lines.push(`- ${q}`);
            }
            return lines.join("\n");
          } catch (err) {
            capture.recordToolCall("split_subheads", { rationale, heads }, "error");
            return `split_subheads failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      }),
    };

    return Object.fromEntries(Object.entries(all).filter(([name]) => isAllowed(name)));
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

    const journal = new HeadJournal(this.sql.bind(this) as unknown as SqlExecutor);
    const facet = this;
    const runtime = {
      async spawnHead(childInput: HeadInput) {
        const stub = await facet.subAgent(ExplorationAgent, childInput.id);
        const owner = facet.getOwnerUserId();
        if (owner) await stub.setOwner(owner);
        // Propagate the ROOT orchestrator unchanged so the whole subtree shares
        // one common findings scratch (not this intermediate head).
        const sharedParent = facet.getSharedParent();
        if (sharedParent) await stub.setSharedParent(sharedParent);
        await stub.initHead(childInput);
        return {
          id: childInput.id,
          async run(): Promise<HeadReport> { return (await stub.runAsHead()) as HeadReport; },
          async abort(reason: string) {
            try { await stub.abortHead(reason); } catch {}
            try { await facet.abortSubAgent(ExplorationAgent, childInput.id); } catch {}
          },
        };
      },
      async mergeLLM(prompt: string): Promise<MergeOutput> {
        return generateJson({
          model: facet.getModel(parentInput.model),
          schema: MergeOutputSchema,
          prompt,
          maxOutputTokens: 2048,
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
    });

    return {
      narrative: result.mergedNarrative,
      decisions: result.selectedDecisions,
      unresolvedQuestions: result.unresolvedQuestions,
      childHeadIds: result.headIds,
      headCount: result.costSummary.headCount,
    };
  }

  // The head loop, system prompt, inherited-context messages, accumulator tools,
  // and report assembly now live in core (runHeadInference + buildHead*); this
  // Facet only supplies the model + scratch tools (sandbox/shared/recursive-split).
}
