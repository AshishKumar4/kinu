/**
 * HeadAgent — Facet that runs one branching head.
 *
 * Spawned by HeadController via `orchestrator.subAgent(HeadAgent, id)`. Each
 * instance:
 *   • is an isolated Durable Object with its own SQLite
 *   • receives a HeadInput on @callable() init() — full conversation context,
 *     task, rationale, budget, allowed tool/sandbox names
 *   • runs an inference loop on @callable() run() — streamText + restricted
 *     ToolSet, accumulating evidence / decisions / artifact refs
 *   • returns a HeadReport
 *
 * Restrictions (Agent SDK facet rules):
 *   • schedule(), keepAlive(), runFiber() throw in facets — we don't use them
 *   • only this DO's SQLite; the parent's memory is mirrored read-only
 *     into the inheritedContext at spawn time
 *
 * v1 sandbox access:
 *   • Each head gets its own VirtualSandbox (per-facet SqliteFS + shell)
 *   • Parent's heavy sandboxes (container, nimbus) are NOT directly reachable
 *     in v1 — the head writes findings + recommendations, parent acts on them
 *     after merge. v2 will add a parent-RPC bridge for true parallel work.
 */

import { Agent, callable } from "agents";
import { generateText, generateObject, tool, jsonSchema } from "ai";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import {
  type HeadId,
  type HeadInput,
  type HeadReport,
  type Evidence,
  type Decision,
  type ArtifactRef,
  type ToolCallRecord,
  type SerializedMessage,
  type MergeStrategy,
  type SplitRequest,
  type HeadBudget,
  type MergeResult,
  budgetExhausted,
  deriveChildBudget,
  createVirtualSandbox,
  type SandboxApi,
  type ShellResult,
  HeadController,
  HeadJournal,
  MergeOutputSchema,
  type MergeOutput,
} from "@proteus/core";
import { SqliteFS } from "@proteus/agent-utils/vfs";
import { createShell } from "@proteus/agent-utils/shell";
import type { SqlExecutor } from "@proteus/agent-utils";
import { nanoid } from "@proteus/core";

const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.6";
const MAX_STEPS_FALLBACK = 16;

export class HeadAgent extends Agent<Env> {
  // Set in init(); persisted across calls within a single facet lifetime.
  private input: HeadInput | null = null;

  // Ephemeral working state — accumulated during run() via tool callbacks.
  private evidence: Evidence[] = [];
  private decisions: Decision[] = [];
  private artifacts: ArtifactRef[] = [];
  private toolCalls: ToolCallRecord[] = [];
  private tokenUsage = { input: 0, output: 0 };
  private startedAt = 0;
  private aborted = false;
  private abortReason: string | null = null;
  // Recursive splits — heads this head spawned during its run.
  private childHeadIds: HeadId[] = [];

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
    // Each head's own SQLite — independent from the orchestrator's.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS head_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS head_scratch (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  }

  private buildSandbox(): SandboxApi {
    const sql = this.sql.bind(this) as unknown as SqlExecutor;
    const fs = new SqliteFS(sql);
    fs.init();
    const shell = createShell(fs);
    return createVirtualSandbox({
      id: `head-${this.input?.id ?? this.name}`,
      vfs: fs,
      shell,
    });
  }

  @callable()
  async init(input: HeadInput): Promise<{ ok: true; id: HeadId }> {
    this.input = input;
    this.evidence = [];
    this.decisions = [];
    this.artifacts = [];
    this.toolCalls = [];
    this.tokenUsage = { input: 0, output: 0 };
    this.aborted = false;
    this.abortReason = null;
    // Persist the input so a recovery (DO restart mid-run) can resume.
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO head_state (key, value) VALUES ('input', ?)`,
      JSON.stringify(input),
    );
    return { ok: true, id: input.id };
  }

  @callable()
  async abort(reason: string): Promise<{ ok: true }> {
    this.aborted = true;
    this.abortReason = reason;
    return { ok: true };
  }

  /**
   * Run the head's inference loop. Returns the final HeadReport.
   *
   * Builds: system prompt + inherited context as messages + the task as the
   * final user turn. Provides a restricted ToolSet:
   *   record_evidence  — appends to in-memory evidence
   *   record_decision  — appends to in-memory decisions
   *   sandbox_exec     — VirtualSandbox.exec
   *   sandbox_read     — VirtualSandbox.readFile
   *   sandbox_write    — VirtualSandbox.writeFile
   *   sandbox_list     — VirtualSandbox.readdir
   *
   * Loops up to maxSteps (derived from budget). On wall-clock exhaustion
   * mid-run, returns status='budget_exceeded' with whatever was collected.
   */
  @callable()
  async run(): Promise<HeadReport> {
    if (!this.input) {
      throw new Error("HeadAgent.run() called before init()");
    }
    const input = this.input;
    this.startedAt = Date.now();
    const sandbox = this.buildSandbox();

    const tools = this.buildTools(input, sandbox);
    const model = this.getModel(input.model);
    const systemPrompt = this.buildSystemPrompt(input);
    const messages = this.buildMessages(input);

    const maxSteps = this.deriveMaxSteps(input);

    try {
      const result = await generateText({
        model,
        system: systemPrompt,
        messages,
        tools,
        stopWhen: ({ steps }) => {
          if (this.aborted) return true;
          if (steps.length >= maxSteps) return true;
          const bExh = budgetExhausted(input.budget);
          if (bExh.exhausted) return true;
          return false;
        },
        maxOutputTokens: 2048,
      });

      // Track token usage from the AI SDK result.
      const usage = (result as unknown as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
      if (usage) {
        this.tokenUsage.input += usage.inputTokens ?? 0;
        this.tokenUsage.output += usage.outputTokens ?? 0;
      }

      const status: HeadReport["status"] = this.aborted
        ? "aborted"
        : budgetExhausted(input.budget).exhausted
          ? "budget_exceeded"
          : "completed";

      // Use the LLM's final text as the summary, fallback to a stub if empty.
      const finalText = result.text?.trim() ?? "";
      const summary = finalText || this.fallbackSummary(input, status);

      return {
        id: input.id,
        status,
        summary,
        evidence: [...this.evidence],
        decisions: [...this.decisions],
        artifactRefs: [...this.artifacts],
        childHeadIds: [...this.childHeadIds],
        toolCalls: [...this.toolCalls],
        tokenUsage: {
          input: this.tokenUsage.input,
          output: this.tokenUsage.output,
          total: this.tokenUsage.input + this.tokenUsage.output,
        },
        wallClockMs: Date.now() - this.startedAt,
        errorMessage: this.abortReason ?? undefined,
      };
    } catch (err) {
      return {
        id: input.id,
        status: "errored",
        summary: `Head ${input.id} errored: ${err instanceof Error ? err.message : String(err)}`,
        evidence: [...this.evidence],
        decisions: [...this.decisions],
        artifactRefs: [...this.artifacts],
        childHeadIds: [],
        toolCalls: [...this.toolCalls],
        tokenUsage: {
          input: this.tokenUsage.input,
          output: this.tokenUsage.output,
          total: this.tokenUsage.input + this.tokenUsage.output,
        },
        wallClockMs: Date.now() - this.startedAt,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Tool builders ─────────────────────────────────────────────────

  private buildTools(input: HeadInput, sandbox: SandboxApi) {
    const allowedToolNames = new Set(input.allowedTools ?? []);
    const isAllowed = (name: string) =>
      input.allowedTools === undefined || allowedToolNames.has(name);

    const allTools = {
      record_evidence: tool({
        description:
          "Record a piece of evidence you've gathered. Use this for facts you " +
          "want surfaced in the merge synthesis. Provide a brief body + optional ref.",
        inputSchema: jsonSchema<{ kind: Evidence["kind"]; body: string; ref?: string; confidence?: number }>({
          type: "object",
          properties: {
            kind: { type: "string", enum: ["tool_output", "fact", "citation", "artifact"] },
            body: { type: "string", description: "1-2 sentence summary of the evidence" },
            ref: { type: "string", description: "Optional source: file path, URL, tool call id" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["kind", "body"],
        }),
        execute: async ({ kind, body, ref, confidence }) => {
          const ev: Evidence = { id: `ev-${nanoid(6)}`, kind, body, ref, confidence };
          this.evidence.push(ev);
          this.recordToolCall("record_evidence", { kind, body, ref, confidence }, "ok");
          return `evidence recorded (id=${ev.id})`;
        },
      }),

      record_decision: tool({
        description:
          "Record a decision: a question this head considered and the answer chosen. " +
          "Decisions surface in the merge synthesis for the parent to reconcile across heads.",
        inputSchema: jsonSchema<{ question: string; choice: string; rationale: string; supportingEvidence?: string[] }>({
          type: "object",
          properties: {
            question: { type: "string" },
            choice: { type: "string" },
            rationale: { type: "string" },
            supportingEvidence: { type: "array", items: { type: "string" } },
          },
          required: ["question", "choice", "rationale"],
        }),
        execute: async ({ question, choice, rationale, supportingEvidence }) => {
          const dec: Decision = { question, choice, rationale, supportingEvidence };
          this.decisions.push(dec);
          this.recordToolCall("record_decision", { question, choice, rationale }, "ok");
          return `decision recorded`;
        },
      }),

      sandbox_exec: tool({
        description: "Run a shell command in this head's ephemeral sandbox.",
        inputSchema: jsonSchema<{ command: string }>({
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        }),
        execute: async ({ command }) => {
          const r: ShellResult = await sandbox.exec(command);
          this.recordToolCall("sandbox_exec", { command }, `exit=${r.exitCode}`);
          if (r.exitCode !== 0) return `Exit ${r.exitCode}${r.stderr ? ": " + r.stderr : ""}`;
          return r.stdout || "(no output)";
        },
      }),

      sandbox_read: tool({
        description: "Read a file from this head's ephemeral sandbox.",
        inputSchema: jsonSchema<{ path: string }>({
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        }),
        execute: async ({ path }) => {
          try {
            const content = await sandbox.readFile(path);
            this.recordToolCall("sandbox_read", { path }, "ok");
            return content;
          } catch (err) {
            this.recordToolCall("sandbox_read", { path }, "error");
            return `read error: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      }),

      sandbox_write: tool({
        description: "Write content to a file in this head's ephemeral sandbox.",
        inputSchema: jsonSchema<{ path: string; content: string }>({
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        }),
        execute: async ({ path, content }) => {
          try {
            await sandbox.writeFile(path, content);
            this.artifacts.push({ kind: "file", ref: path, description: `head-written file (${content.length}b)` });
            this.recordToolCall("sandbox_write", { path, contentLen: content.length }, "ok");
            return `wrote ${content.length} bytes to ${path}`;
          } catch (err) {
            this.recordToolCall("sandbox_write", { path }, "error");
            return `write error: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      }),

      sandbox_list: tool({
        description: "List directory contents in this head's ephemeral sandbox.",
        inputSchema: jsonSchema<{ path: string }>({
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        }),
        execute: async ({ path }) => {
          try {
            const entries = await sandbox.readdir(path);
            this.recordToolCall("sandbox_list", { path }, "ok");
            return entries.map((e) => `${e.isDirectory ? "d" : "-"} ${e.name}${e.size != null ? ` (${e.size}b)` : ""}`).join("\n");
          } catch (err) {
            this.recordToolCall("sandbox_list", { path }, "error");
            return `list error: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      }),

      // v2: recursive head splitting. Reduces depth by 1 per spawn;
      // budget split is equal across children by default. Result is the
      // merged narrative + decisions, which this head can then act on.
      split_subheads: tool({
        description:
          "Spawn 2-4 child heads recursively to explore narrower sub-questions of your own task. " +
          "Each child sees the same inherited conversation context you do. " +
          "Children's findings are merged via LLM synthesis and returned as a single narrative — " +
          "you should then use that narrative to inform your own summary. Depth is bounded; " +
          "this call may fail if your depth budget is exhausted.",
        inputSchema: jsonSchema<{
          rationale: string;
          heads: Array<{ task: string; rationale: string }>;
          merge_strategy?: MergeStrategy;
        }>({
          type: "object",
          required: ["rationale", "heads"],
          properties: {
            rationale: { type: "string", description: "Why the recursive split is warranted." },
            heads: {
              type: "array", minItems: 2, maxItems: 4,
              items: {
                type: "object", required: ["task", "rationale"],
                properties: {
                  task: { type: "string" },
                  rationale: { type: "string" },
                },
              },
            },
            merge_strategy: {
              type: "string",
              enum: ["synthesize", "best_of", "consensus"],
              description: "How to combine the children's findings. Default: synthesize.",
            },
          },
        }),
        execute: async ({ rationale, heads, merge_strategy }): Promise<string> => {
          const bExh = budgetExhausted(input.budget);
          if (bExh.exhausted) {
            return `Cannot split: budget exhausted (${bExh.reason}).`;
          }
          if (input.budget.maxDepth <= 0) {
            return "Cannot split: maxDepth budget reached.";
          }

          try {
            const result = await this.runRecursiveSplit({
              rationale,
              heads,
              mergeStrategy: merge_strategy ?? input.mergeStrategy,
            }, input.budget, input);

            for (const childId of result.childHeadIds) {
              this.childHeadIds.push(childId);
            }
            this.recordToolCall("split_subheads", { rationale, heads }, `merged ${result.headCount} children`);

            const lines: string[] = [];
            lines.push(result.narrative);
            if (result.decisions.length > 0) {
              lines.push("");
              lines.push("Children's selected decisions:");
              for (const d of result.decisions) {
                lines.push(`- ${d.question}: ${d.choice}`);
              }
            }
            if (result.unresolvedQuestions.length > 0) {
              lines.push("");
              lines.push("Open questions:");
              for (const q of result.unresolvedQuestions) lines.push(`- ${q}`);
            }
            return lines.join("\n");
          } catch (err) {
            this.recordToolCall("split_subheads", { rationale, heads }, "error");
            return `split_subheads failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      }),
    };

    // Filter by allowedTools if specified.
    return Object.fromEntries(
      Object.entries(allTools).filter(([name]) => isAllowed(name)),
    );
  }

  /**
   * Run a recursive split from inside a head. Builds a one-off HeadController
   * + HeadRuntime that spawns child HeadAgents off THIS facet (so children
   * are facets of this head, not the orchestrator). Returns a minimal merge
   * result the parent tool can stringify.
   */
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
    // Build a journal scoped to this facet's own SQLite. (Sibling facet's
    // journal lives on the orchestrator; recursive children's journal can
    // live here without competing with the parent's chat SQLite.)
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS head_journal (
      id TEXT PRIMARY KEY, parent_id TEXT, root_id TEXT NOT NULL, depth INTEGER NOT NULL,
      task TEXT NOT NULL, rationale TEXT, status TEXT NOT NULL, spawned_at INTEGER NOT NULL,
      completed_at INTEGER, token_input INTEGER DEFAULT 0, token_output INTEGER DEFAULT 0,
      wall_clock_ms INTEGER DEFAULT 0, summary TEXT, error_message TEXT,
      decisions_json TEXT, artifacts_json TEXT, tool_calls_json TEXT,
      child_head_ids_json TEXT, merge_strategy TEXT NOT NULL DEFAULT 'synthesize')`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS head_evidence (
      id TEXT PRIMARY KEY, head_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
      ref TEXT, confidence REAL, created_at INTEGER NOT NULL)`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS head_merge_results (
      root_id TEXT PRIMARY KEY, merged_narrative TEXT NOT NULL,
      selected_decisions_json TEXT, unresolved_questions_json TEXT,
      recommendations_json TEXT, cost_head_count INTEGER NOT NULL,
      cost_total_tokens INTEGER NOT NULL, cost_total_wall_ms INTEGER NOT NULL,
      cost_max_depth INTEGER NOT NULL, merged_at INTEGER NOT NULL,
      merge_strategy TEXT NOT NULL)`);

    const journal = new HeadJournal(this.sql.bind(this) as never);

    // Children are facets of THIS HeadAgent (recursive — same class).
    const headAgent = this;
    const runtime = {
      async spawnHead(childInput: HeadInput) {
        const stub = await headAgent.subAgent(HeadAgent, childInput.id);
        await stub.init(childInput);
        return {
          id: childInput.id,
          async run(): Promise<HeadReport> { return (await stub.run()) as HeadReport; },
          async abort(reason: string) {
            try { await stub.abort(reason); } catch {}
            try { await headAgent.abortSubAgent(HeadAgent, childInput.id); } catch {}
          },
        };
      },
      async mergeLLM(prompt: string, _schema: typeof MergeOutputSchema): Promise<MergeOutput> {
        const { generateObject } = await import("ai");
        const { object } = await generateObject({
          model: headAgent.getModel(parentInput.model),
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
      childHeadIds: result.evidenceAggregate.map((e) => e.id), // best-effort proxy
      headCount: result.costSummary.headCount,
    };
  }

  private recordToolCall(name: string, args: Record<string, unknown>, summary: string) {
    this.toolCalls.push({
      id: `tc-${nanoid(6)}`,
      toolName: name,
      args,
      result: summary,
      timestamp: Date.now(),
    });
  }

  private buildSystemPrompt(input: HeadInput): string {
    return [
      `You are a "head" — one of ${this.contextDescription(input)} parallel reasoning threads working in a self-evolving agent runtime.`,
      ``,
      `Your task: ${input.task}`,
      `Why you were spawned: ${input.rationale}`,
      `Merge strategy: ${input.mergeStrategy} (your work will be combined with sibling heads via this strategy).`,
      ``,
      `Conventions:`,
      `- Call record_evidence whenever you learn something worth surfacing in the merge.`,
      `- Call record_decision when you make a substantive choice that the parent (or sibling heads) might disagree with.`,
      `- Use sandbox_exec / sandbox_read / sandbox_write / sandbox_list to explore your ephemeral filesystem. This is YOUR scratch space — siblings cannot see it.`,
      `- Keep your final text response to 2-4 sentences summarizing what you found and recommending what should happen next. This becomes your "summary" in the merge.`,
      `- Stay focused on YOUR task. Don't try to do sibling heads' work.`,
      ``,
      `Budget: depth ${input.budget.maxDepth}, ${input.budget.maxTokens} tokens, ${input.budget.maxWallClockMs}ms wall-clock.`,
    ].join("\n");
  }

  private contextDescription(_input: HeadInput): string {
    return "several";
  }

  private buildMessages(input: HeadInput): Array<{ role: "user" | "assistant"; content: string }> {
    // Compress inherited context into a single user message that frames the
    // parent conversation. Past tool calls are summarized; past assistant
    // turns are quoted verbatim if short.
    const lines: string[] = [];
    lines.push("Here is the conversation you inherit:");
    lines.push("");
    for (const m of input.inheritedContext) {
      const trimmed = m.content.length > 400 ? m.content.slice(0, 400) + "…" : m.content;
      lines.push(`[${m.role}${m.toolName ? `/${m.toolName}` : ""}] ${trimmed}`);
    }
    lines.push("");
    lines.push(`Now focus on your assigned task: ${input.task}`);
    return [{ role: "user", content: lines.join("\n") }];
  }

  private deriveMaxSteps(input: HeadInput): number {
    // Loose heuristic: ~600 tokens per step, halved for safety.
    const fromBudget = Math.max(1, Math.floor(input.budget.maxTokens / 1200));
    return Math.min(MAX_STEPS_FALLBACK, fromBudget);
  }

  private fallbackSummary(input: HeadInput, status: HeadReport["status"]): string {
    if (status === "completed") {
      return `Head ${input.id} produced no final text but recorded ${this.evidence.length} evidence and ${this.decisions.length} decisions.`;
    }
    return `Head ${input.id} ended with status=${status}${this.abortReason ? ` (${this.abortReason})` : ""}.`;
  }
}

// Re-export for type imports if used externally.
export type { HeadInput, HeadReport, Evidence, Decision } from "@proteus/core";
