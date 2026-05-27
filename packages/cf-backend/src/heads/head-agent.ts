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
  budgetExhausted,
  createVirtualSandbox,
  type SandboxApi,
  type ShellResult,
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
        childHeadIds: [],
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
    };

    // Filter by allowedTools if specified.
    return Object.fromEntries(
      Object.entries(allTools).filter(([name]) => isAllowed(name)),
    );
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
