/**
 * ExplorationAgent — MCTS branch sub-agent via Facets.
 *
 * Each instance is an isolated DO with its own SQLite (traces table).
 * Spawned by OrchestratorAgent.subAgent(ExplorationAgent, branchId).
 *
 * Constraints (Agent SDK facets):
 *   - schedule(), keepAlive(), runFiber() all throw in facets
 *   - Own SQLite: only traces table, no access to orchestrator's data
 *   - LLM config injected per-call from the orchestrator
 */

import { Agent, callable } from "agents";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { CraftedTool } from "@proteus/core";

const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.6";

export class ExplorationAgent extends Agent<Env> {
  private getModel(): LanguageModel {
    const env = this.env as Env & Record<string, string>;
    if (env.AI && typeof env.AI !== "string") {
      return createWorkersAI({ binding: env.AI })(DEFAULT_MODEL);
    }
    const compatModel = DEFAULT_MODEL.startsWith("workers-ai/") ? DEFAULT_MODEL : `workers-ai/${DEFAULT_MODEL}`;
    return createOpenAICompatible({
      name: "workers-ai",
      baseURL: env.AI_GATEWAY_URL ?? "",
      headers: { "Authorization": env.AI_GATEWAY_AUTH ?? "" },
    }).chatModel(compatModel);
  }

  async onStart() {
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
    // Extract code from markdown code blocks if present
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
}
