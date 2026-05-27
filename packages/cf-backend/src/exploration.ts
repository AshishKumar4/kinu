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
 *   HEAD mode  (v2)       — long-form multi-step inference used by the
 *                           branching-heads primitive (split_heads tool).
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
import { generateText, generateObject, tool, jsonSchema } from "ai";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  type CraftedTool,
  type HeadId,
  type HeadInput,
  type HeadReport,
  type Evidence,
  type Decision,
  type ArtifactRef,
  type ToolCallRecord,
  type MergeStrategy,
  type HeadBudget,
  type MergeResult,
  budgetExhausted,
  HeadController,
  HeadJournal,
  MergeOutputSchema,
  type MergeOutput,
  nanoid,
} from "@proteus/core";
import { SqliteFS } from "@proteus/agent-utils/vfs";
import { createShell, type ShellResult } from "@proteus/agent-utils/shell";
import type { SqlExecutor } from "@proteus/agent-utils";

const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.6";
const MAX_HEAD_STEPS = 16;

export class ExplorationAgent extends Agent<Env> {
  // ── MCTS-mode state (pre-existing) ──────────────────────────────

  // ── Head-mode state (v2) ────────────────────────────────────────
  private headInput: HeadInput | null = null;
  private headEvidence: Evidence[] = [];
  private headDecisions: Decision[] = [];
  private headArtifacts: ArtifactRef[] = [];
  private headToolCalls: ToolCallRecord[] = [];
  private headTokenUsage = { input: 0, output: 0 };
  private headStartedAt = 0;
  private headAborted = false;
  private headAbortReason: string | null = null;
  private headChildIds: HeadId[] = [];

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

  private getModel(modelId?: string): LanguageModel {
    const id = modelId ?? DEFAULT_MODEL;
    const env = this.env as Env & Record<string, string>;
    if (env.AI && typeof env.AI !== "string") {
      return createWorkersAI({ binding: env.AI })(id);
    }
    const compatId = id.startsWith("workers-ai/") ? id : `workers-ai/${id}`;
    return createOpenAICompatible({
      name: "workers-ai",
      baseURL: env.AI_GATEWAY_URL ?? "",
      headers: { Authorization: env.AI_GATEWAY_AUTH ?? "" },
    }).chatModel(compatId);
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

  // ── Head mode @callables (v2) ───────────────────────────────────

  /** Initialize this facet as a branching-heads worker. */
  @callable()
  async initHead(input: HeadInput): Promise<{ ok: true; id: HeadId }> {
    this.headInput = input;
    this.headEvidence = [];
    this.headDecisions = [];
    this.headArtifacts = [];
    this.headToolCalls = [];
    this.headTokenUsage = { input: 0, output: 0 };
    this.headAborted = false;
    this.headAbortReason = null;
    this.headChildIds = [];
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
    this.headStartedAt = Date.now();

    const tools = this.buildHeadTools(input);
    const model = this.getModel(input.model);
    const systemPrompt = this.buildHeadSystemPrompt(input);
    const messages = this.buildHeadMessages(input);
    const maxSteps = Math.min(MAX_HEAD_STEPS, Math.max(1, Math.floor(input.budget.maxTokens / 1200)));

    try {
      const result = await generateText({
        model,
        system: systemPrompt,
        messages,
        tools,
        stopWhen: ({ steps }) => {
          if (this.headAborted) return true;
          if (steps.length >= maxSteps) return true;
          if (budgetExhausted(input.budget).exhausted) return true;
          return false;
        },
        maxOutputTokens: 2048,
      });

      const usage = (result as unknown as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
      if (usage) {
        this.headTokenUsage.input += usage.inputTokens ?? 0;
        this.headTokenUsage.output += usage.outputTokens ?? 0;
      }

      const status: HeadReport["status"] = this.headAborted
        ? "aborted"
        : budgetExhausted(input.budget).exhausted ? "budget_exceeded" : "completed";

      const finalText = result.text?.trim() ?? "";
      const summary = finalText || this.headFallbackSummary(input, status);

      return {
        id: input.id, status, summary,
        evidence: [...this.headEvidence],
        decisions: [...this.headDecisions],
        artifactRefs: [...this.headArtifacts],
        childHeadIds: [...this.headChildIds],
        toolCalls: [...this.headToolCalls],
        tokenUsage: {
          input: this.headTokenUsage.input,
          output: this.headTokenUsage.output,
          total: this.headTokenUsage.input + this.headTokenUsage.output,
        },
        wallClockMs: Date.now() - this.headStartedAt,
        errorMessage: this.headAbortReason ?? undefined,
      };
    } catch (err) {
      return {
        id: input.id, status: "errored",
        summary: `Head ${input.id} errored: ${err instanceof Error ? err.message : String(err)}`,
        evidence: [...this.headEvidence],
        decisions: [...this.headDecisions],
        artifactRefs: [...this.headArtifacts],
        childHeadIds: [...this.headChildIds],
        toolCalls: [...this.headToolCalls],
        tokenUsage: {
          input: this.headTokenUsage.input,
          output: this.headTokenUsage.output,
          total: this.headTokenUsage.input + this.headTokenUsage.output,
        },
        wallClockMs: Date.now() - this.headStartedAt,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Head-mode tool builders ─────────────────────────────────────

  private buildHeadTools(input: HeadInput) {
    const allowedToolNames = new Set(input.allowedTools ?? []);
    const isAllowed = (name: string) => input.allowedTools === undefined || allowedToolNames.has(name);

    const facet = this;
    const shell = this.getHeadShell();
    const vfs = this.getHeadVfs();

    const all = {
      record_evidence: tool({
        description:
          "Record a piece of evidence you've gathered. Use this for facts you want surfaced in the merge synthesis.",
        inputSchema: jsonSchema<{ kind: Evidence["kind"]; body: string; ref?: string; confidence?: number }>({
          type: "object", required: ["kind", "body"],
          properties: {
            kind: { type: "string", enum: ["tool_output", "fact", "citation", "artifact"] },
            body: { type: "string" }, ref: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        }),
        execute: async ({ kind, body, ref, confidence }) => {
          const ev: Evidence = { id: `ev-${nanoid(6)}`, kind, body, ref, confidence };
          facet.headEvidence.push(ev);
          facet.recordHeadToolCall("record_evidence", { kind, body, ref, confidence }, "ok");
          return `evidence recorded (id=${ev.id})`;
        },
      }),

      record_decision: tool({
        description: "Record a decision the head considered.",
        inputSchema: jsonSchema<{ question: string; choice: string; rationale: string; supportingEvidence?: string[] }>({
          type: "object", required: ["question", "choice", "rationale"],
          properties: {
            question: { type: "string" }, choice: { type: "string" }, rationale: { type: "string" },
            supportingEvidence: { type: "array", items: { type: "string" } },
          },
        }),
        execute: async ({ question, choice, rationale, supportingEvidence }) => {
          const d: Decision = { question, choice, rationale, supportingEvidence };
          facet.headDecisions.push(d);
          facet.recordHeadToolCall("record_decision", { question, choice, rationale }, "ok");
          return `decision recorded`;
        },
      }),

      sandbox_exec: tool({
        description: "Run a shell command in this head's ephemeral sandbox.",
        inputSchema: jsonSchema<{ command: string }>({
          type: "object", required: ["command"], properties: { command: { type: "string" } },
        }),
        execute: async ({ command }) => {
          const r = await shell.exec(command);
          facet.recordHeadToolCall("sandbox_exec", { command }, `exit=${r.exitCode}`);
          if (r.exitCode !== 0) return `Exit ${r.exitCode}${r.stderr ? ": " + r.stderr : ""}`;
          return r.stdout || "(no output)";
        },
      }),

      sandbox_read: tool({
        description: "Read a file from this head's ephemeral sandbox.",
        inputSchema: jsonSchema<{ path: string }>({
          type: "object", required: ["path"], properties: { path: { type: "string" } },
        }),
        execute: async ({ path }) => {
          try {
            const c = await vfs.readFile(path, { encoding: "utf8" });
            facet.recordHeadToolCall("sandbox_read", { path }, "ok");
            return typeof c === "string" ? c : new TextDecoder().decode(c);
          } catch (err) {
            facet.recordHeadToolCall("sandbox_read", { path }, "error");
            return `read error: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      }),

      sandbox_write: tool({
        description: "Write content to a file in this head's ephemeral sandbox.",
        inputSchema: jsonSchema<{ path: string; content: string }>({
          type: "object", required: ["path", "content"],
          properties: { path: { type: "string" }, content: { type: "string" } },
        }),
        execute: async ({ path, content }) => {
          try {
            const dir = path.split("/").slice(0, -1).join("/");
            if (dir) { try { await vfs.mkdir(dir, { recursive: true }); } catch { /* exists */ } }
            await vfs.writeFile(path, content);
            facet.headArtifacts.push({ kind: "file", ref: path, description: `head-written (${content.length}b)` });
            facet.recordHeadToolCall("sandbox_write", { path, contentLen: content.length }, "ok");
            return `wrote ${content.length} bytes to ${path}`;
          } catch (err) {
            facet.recordHeadToolCall("sandbox_write", { path }, "error");
            return `write error: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      }),

      sandbox_list: tool({
        description: "List directory contents in this head's ephemeral sandbox.",
        inputSchema: jsonSchema<{ path: string }>({
          type: "object", required: ["path"], properties: { path: { type: "string" } },
        }),
        execute: async ({ path }) => {
          try {
            const names = await vfs.readdir(path);
            facet.recordHeadToolCall("sandbox_list", { path }, "ok");
            return names.join("\n");
          } catch (err) {
            facet.recordHeadToolCall("sandbox_list", { path }, "error");
            return `list error: ${err instanceof Error ? err.message : String(err)}`;
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
            for (const cid of result.childHeadIds) facet.headChildIds.push(cid);
            facet.recordHeadToolCall("split_subheads", { rationale, heads }, `merged ${result.headCount}`);
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
            facet.recordHeadToolCall("split_subheads", { rationale, heads }, "error");
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
    // splits can persist locally without competing with the orchestrator.
    const execRaw = (ddl: string) => this.ctx.storage.sql.exec(ddl);
    execRaw(`CREATE TABLE IF NOT EXISTS head_journal (
      id TEXT PRIMARY KEY, parent_id TEXT, root_id TEXT NOT NULL, depth INTEGER NOT NULL,
      task TEXT NOT NULL, rationale TEXT, status TEXT NOT NULL, spawned_at INTEGER NOT NULL,
      completed_at INTEGER, token_input INTEGER DEFAULT 0, token_output INTEGER DEFAULT 0,
      wall_clock_ms INTEGER DEFAULT 0, summary TEXT, error_message TEXT,
      decisions_json TEXT, artifacts_json TEXT, tool_calls_json TEXT,
      child_head_ids_json TEXT, merge_strategy TEXT NOT NULL DEFAULT 'synthesize')`);
    execRaw(`CREATE TABLE IF NOT EXISTS head_evidence (
      id TEXT PRIMARY KEY, head_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
      ref TEXT, confidence REAL, created_at INTEGER NOT NULL)`);
    execRaw(`CREATE TABLE IF NOT EXISTS head_merge_results (
      root_id TEXT PRIMARY KEY, merged_narrative TEXT NOT NULL,
      selected_decisions_json TEXT, unresolved_questions_json TEXT,
      recommendations_json TEXT, cost_head_count INTEGER NOT NULL,
      cost_total_tokens INTEGER NOT NULL, cost_total_wall_ms INTEGER NOT NULL,
      cost_max_depth INTEGER NOT NULL, merged_at INTEGER NOT NULL,
      merge_strategy TEXT NOT NULL)`);

    const journal = new HeadJournal(this.sql.bind(this) as never);
    const facet = this;
    const runtime = {
      async spawnHead(childInput: HeadInput) {
        const stub = await facet.subAgent(ExplorationAgent, childInput.id);
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
      async mergeLLM(prompt: string, _schema: typeof MergeOutputSchema): Promise<MergeOutput> {
        const { object } = await generateObject({
          model: facet.getModel(parentInput.model),
          schema: MergeOutputSchema,
          prompt,
          maxOutputTokens: 2048,
        });
        return object as MergeOutput;
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

  // ── Head-mode prompt + helpers ──────────────────────────────────

  private recordHeadToolCall(name: string, args: Record<string, unknown>, summary: string) {
    this.headToolCalls.push({
      id: `tc-${nanoid(6)}`, toolName: name, args,
      result: summary, timestamp: Date.now(),
    });
  }

  private buildHeadSystemPrompt(input: HeadInput): string {
    return [
      `You are a "head" — one of several parallel reasoning threads in a self-evolving agent runtime.`,
      ``,
      `Your task: ${input.task}`,
      `Why you were spawned: ${input.rationale}`,
      `Merge strategy: ${input.mergeStrategy} (your work will be combined with sibling heads via this strategy).`,
      ``,
      `Conventions:`,
      `- record_evidence whenever you learn something worth surfacing in the merge.`,
      `- record_decision when you make a substantive choice the parent might want to reconcile.`,
      `- sandbox_exec / sandbox_read / sandbox_write / sandbox_list = YOUR scratch space (siblings can't see it).`,
      `- split_subheads to recursively explore deeper if needed (depth-budgeted).`,
      `- Final text response: 2-4 sentences summarizing what you found + recommending what should happen next.`,
      `- Stay focused on YOUR task. Don't try to do sibling heads' work.`,
      ``,
      `Budget: depth ${input.budget.maxDepth}, ${input.budget.maxTokens} tokens, ${input.budget.maxWallClockMs}ms wall-clock.`,
    ].join("\n");
  }

  private buildHeadMessages(input: HeadInput): Array<{ role: "user" | "assistant"; content: string }> {
    const lines: string[] = ["Here is the conversation you inherit:", ""];
    for (const m of input.inheritedContext) {
      const trimmed = m.content.length > 400 ? m.content.slice(0, 400) + "…" : m.content;
      lines.push(`[${m.role}${m.toolName ? `/${m.toolName}` : ""}] ${trimmed}`);
    }
    lines.push("", `Now focus on your assigned task: ${input.task}`);
    return [{ role: "user", content: lines.join("\n") }];
  }

  private headFallbackSummary(input: HeadInput, status: HeadReport["status"]): string {
    if (status === "completed") {
      return `Head ${input.id} produced no final text but recorded ${this.headEvidence.length} evidence and ${this.headDecisions.length} decisions.`;
    }
    return `Head ${input.id} ended with status=${status}${this.headAbortReason ? ` (${this.headAbortReason})` : ""}.`;
  }
}
