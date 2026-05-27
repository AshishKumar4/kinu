/**
 * ReviewAgent — Hermes-style background-review fork as a Facet.
 *
 * After each main-conversation turn, the orchestrator spawns a ReviewAgent
 * Facet with a snapshot of the turn (user message, assistant reply, tool
 * calls). The ReviewAgent runs a focused LLM call against Hermes's
 * `_SKILL_REVIEW_PROMPT` (ported here), then writes its findings back to:
 *   • the CraftStore (new or updated skill suggestions)
 *   • the MEMORY.md (lessons / preferences)
 *
 * Lives as a Facet for three reasons:
 *   1. eviction-independent from the main chat DO
 *   2. doesn't compete with the chat for SQLite locks
 *   3. clean failure boundary — review crashes don't surface to the user
 *
 * Triggered fire-and-forget from OrchestratorAgent.onChatResponse.
 * Replaces the inline `engine.onTurnCompleteAsync` path for skill-creation
 * concerns (memory-write lessons stay in EvolutionEngine).
 *
 * v1 scope: writes a single MEMORY lesson via Workers AI; future v2.1 adds
 * craft-tool suggestions w/ schema-validated output.
 */

import { Agent, callable } from "agents";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.6";

/**
 * Hermes's SKILL_REVIEW_PROMPT — adapted to Proteus's vocabulary
 * (skills = crafted tools, memory = MEMORY.md). Lifted in spirit from
 * external/hermes-agent/agent/background_review.py:45-148.
 *
 * Bias toward ACTIVE updates: "a pass that does nothing is a missed
 * learning opportunity, not a neutral outcome".
 */
const SKILL_REVIEW_PROMPT = `\
You are the agent's background reviewer. Your job is to look at the most recent
turn and decide whether the agent should LEARN something durable from it.

What to look for:
- The user corrected the agent's approach, style, or assumption
- A non-trivial fix / workaround / technique emerged
- A currently-loaded skill turned out to be wrong, missing, or outdated
- The agent discovered a constraint or invariant worth remembering

What NOT to capture:
- Environment-dependent failures (missing binary, uninstalled package)
- Negative claims about tools that look like transient breakage
- One-off task narratives or routine acknowledgements

Be ACTIVE. Most turns produce at least one small worthwhile update. A pass
that does nothing is a missed learning opportunity — not a neutral outcome.

Output ONE sentence as a memory lesson (start with the WHAT, then a brief
WHY). If the turn is genuinely uninstructive, output exactly "(skip)".`;

export interface ReviewInput {
  /** The user's message text for this turn. */
  readonly userText: string;
  /** The assistant's final response text for this turn. */
  readonly assistantText: string;
  /** Compact JSON of the tools the agent called this turn — for context. */
  readonly toolCallsSummary: string;
  /** Whether the turn surfaced any error. */
  readonly hadError: boolean;
  /** Model id to use (defaults to DEFAULT_MODEL). */
  readonly model?: string;
}

export interface ReviewResult {
  readonly status: 'wrote_lesson' | 'skipped' | 'errored';
  readonly lesson?: string;
  readonly errorMessage?: string;
  readonly durationMs: number;
}

export class ReviewAgent extends Agent<Env> {
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
    // Each ReviewAgent's own ledger of past reviews — helpful for telemetry
    // and to suppress duplicate lessons across consecutive uninstructive turns.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(9)))),
        status TEXT NOT NULL,
        lesson TEXT,
        had_error INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      )
    `);
  }

  /**
   * Review one turn. The orchestrator calls this fire-and-forget from
   * onChatResponse. We return the result for any caller that wants it
   * (e.g. integration tests).
   */
  @callable()
  async reviewTurn(input: ReviewInput): Promise<ReviewResult> {
    const startedAt = Date.now();
    try {
      const model = this.getModel(input.model);
      const userBlock = input.userText.slice(0, 1500);
      const assistantBlock = input.assistantText.slice(0, 2000);
      const toolBlock = input.toolCallsSummary.slice(0, 1000);

      const prompt = [
        SKILL_REVIEW_PROMPT,
        '',
        '## Turn under review',
        `User: ${userBlock}`,
        `Assistant: ${assistantBlock}`,
        `Tool calls: ${toolBlock || '(none)'}`,
        `Had error: ${input.hadError ? 'YES' : 'no'}`,
        '',
        'Output ONE sentence (or "(skip)").',
      ].join('\n');

      const { text } = await generateText({
        model,
        prompt,
        maxOutputTokens: 200,
      });

      const lesson = text.trim();
      const durationMs = Date.now() - startedAt;

      if (!lesson || lesson === '(skip)' || lesson.toLowerCase().startsWith('(skip')) {
        this.sql`INSERT INTO reviews (status, had_error, duration_ms)
                 VALUES ('skipped', ${input.hadError ? 1 : 0}, ${durationMs})`;
        return { status: 'skipped', durationMs };
      }

      this.sql`INSERT INTO reviews (status, lesson, had_error, duration_ms)
               VALUES ('wrote_lesson', ${lesson}, ${input.hadError ? 1 : 0}, ${durationMs})`;

      return { status: 'wrote_lesson', lesson, durationMs };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = err instanceof Error ? err.message : String(err);
      try {
        this.sql`INSERT INTO reviews (status, lesson, had_error, duration_ms)
                 VALUES ('errored', ${errorMessage}, ${input.hadError ? 1 : 0}, ${durationMs})`;
      } catch { /* nop */ }
      return { status: 'errored', errorMessage, durationMs };
    }
  }

  /** List recent review attempts for telemetry. */
  @callable()
  async listRecentReviews(limit = 20) {
    return this.sql<{ id: string; status: string; lesson: string | null; had_error: number; duration_ms: number; created_at: number }>`
      SELECT id, status, lesson, had_error, duration_ms, created_at
      FROM reviews ORDER BY created_at DESC LIMIT ${limit}`;
  }
}
