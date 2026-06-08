/**
 * EvolutionEngine — manages all 3 timescales of self-evolution.
 *
 * This is NOT a separate "evolve" command — it's baked into the agent loop.
 * After every turn, session, and periodically at the lifetime level,
 * the engine automatically reflects, discovers patterns, and evolves.
 *
 * Architecture reference: final-architecture.md §7 (Evolution at Three Timescales)
 *
 * Timescale 1 — Turn-level (after every response):
 *   Assess quality → on failure: reflect + store → on success: extract pattern
 *
 * Timescale 2 — Session-level (every N turns):
 *   Reflect on patterns → update context blocks → propose scaffold changes
 *
 * Timescale 3 — Lifetime-level (every N conversations or daily):
 *   MCTS exploration → CraftStore consolidation → scaffold canary testing
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import type { SessionWriter } from '../mcts/record-node.js';
import type {
  CompletedTurn,
  CompletedSession,
  EvolutionEvent,
  EvolutionListener,
  EvolutionConfig,
} from './types.js';
import { DEFAULT_EVOLUTION_CONFIG } from './types.js';
import { isoDate } from '../utils/date.js';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured.js';
import { upsertCraftedTool } from '../craft/conflict.js';
import { periodicCraftConsolidation } from '../craft/consolidation.js';
import { updateCraftScores } from '../craft/ema.js';
import { readSoul, summarizeSoul } from '../identity/soul.js';

/**
 * Built-in tool names — crafted-tool scoring ignores these.
 * Sourced from the canonical registry so CF and CLI share one truth.
 */
import { BUILTIN_TOOL_NAMES as BUILT_IN_TOOL_NAMES } from '../tools/registry.js';
import { modifyScaffold } from '../scaffold/modify.js';
import { runMCTS } from '../mcts/engine.js';

/** Single source for the explicit-feedback → turn-quality mapping. Used by
 *  the turn-time assessment AND by the async setTurnFeedback re-scoring path
 *  (cf-backend), so the 0.9/0.2 constants can't drift between them. */
export function feedbackToQuality(feedback: 'positive' | 'negative'): number {
  return feedback === 'positive' ? 0.9 : 0.2;
}

export class EvolutionEngine {
  private rt: AgentRuntime;
  private config: EvolutionConfig;
  private listeners: EvolutionListener[] = [];
  private turnsSinceReflection = 0;
  private conversationCount = 0;

  constructor(rt: AgentRuntime, config?: Partial<EvolutionConfig>) {
    this.rt = rt;
    this.config = { ...DEFAULT_EVOLUTION_CONFIG, ...config };

    // Load conversation count from DB to resume lifetime tracking
    const count = rt.storage.sql<{ c: number }>`
      SELECT COUNT(DISTINCT session_id) as c FROM messages
    `[0]?.c ?? 0;
    this.conversationCount = count;
  }

  /** Subscribe to evolution events (for CLI/UI display) */
  onEvent(listener: EvolutionListener): void {
    this.listeners.push(listener);
  }

  private emit(event: EvolutionEvent): void {
    // Persist to SQL so UI can query it
    try {
      this.rt.storage.sql`INSERT INTO evolution_events (type, message, data, created_at)
        VALUES (${event.type}, ${event.message}, ${event.data ? JSON.stringify(event.data) : null}, ${Date.now()})`;
    } catch {
      // Table may not exist yet in test environments — that's fine
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  // ── Timescale 1: Turn-level (after every response) ──────────────

  /**
   * Called after every agent response. Assesses quality and triggers
   * reflection or pattern extraction automatically.
   */
  async onTurnComplete(turn: CompletedTurn): Promise<void> {
    if (!this.config.enabled) return;

    this.turnsSinceReflection++;

    // Assess quality: use the judge model if available, else heuristic
    const quality = await this.assessTurnQuality(turn);

    // Always emit a turn_complete event so the Evolution pane shows activity
    this.emit({
      type: 'turn_complete' as EvolutionEvent['type'],
      message: `Turn quality: ${quality.toFixed(2)} | ${turn.toolCalls.length} tool calls | ${turn.steps} steps | ${turn.hadError ? 'had errors' : 'clean'}`,
      data: { quality, toolCount: turn.toolCalls.length, steps: turn.steps, durationMs: turn.durationMs },
    });

    // Update EMA scores for any crafted tools that were used in this turn.
    const craftedToolNames = turn.toolCalls
      .map(tc => tc.name)
      .filter(name => !BUILT_IN_TOOL_NAMES.has(name));
    if (craftedToolNames.length > 0) {
      try {
        updateCraftScores(this.rt.storage.sql, craftedToolNames, quality);
      } catch {
        // Score update failure is non-fatal
      }
    }

    // Low quality → generate reflection and store in memory
    if (quality < this.config.turnReflectionThreshold || turn.hadError) {
      const reflection = await this.generateTurnReflection(turn, quality);
      await this.rt.memory.append(
        'memory/MEMORY.md',
        `\n### Lesson (${isoDate()}, quality=${quality.toFixed(2)})\n${reflection}\n`,
      );
      await this.rt.memory.index('memory/MEMORY.md');
      this.emit({ type: 'reflection', message: reflection });
    }

    // High quality with tool usage → extract pattern to CraftStore
    if (quality > this.config.turnCraftThreshold && turn.toolCalls.length > 0) {
      await this.extractPattern(turn, quality);
    }

    // Check if session-level reflection is due
    if (this.turnsSinceReflection >= this.config.sessionReflectionInterval) {
      await this.onSessionReflection();
      this.turnsSinceReflection = 0;
    }
  }

  /**
   * Fire-and-forget variant. The CF backend calls this from onChatResponse to
   * avoid blocking Think's TurnQueue while evolution's LLM reflection runs.
   * Errors are caught and logged, never propagated. Semantically identical to
   * `void this.onTurnComplete(turn).catch(...)` but centralizes the pattern.
   */
  onTurnCompleteAsync(turn: CompletedTurn): void {
    void this.onTurnComplete(turn).catch(err => {
      console.error('[proteus] onTurnComplete failed:', err);
    });
  }

  // ── Timescale 2: Session-level (end of conversation or every N turns) ──

  /**
   * Called when a conversation ends or after N turns.
   * Reflects on patterns, updates context blocks.
   */
  async onSessionComplete(session: CompletedSession): Promise<void> {
    if (!this.config.enabled) return;

    this.conversationCount++;
    const alreadyReflected = this.turnsSinceReflection === 0; // 0 means onTurnComplete just reflected
    this.turnsSinceReflection = 0;

    // Reflect on the entire session (skip if onTurnComplete already reflected this cycle)
    if (session.turns.length >= 3 && !alreadyReflected) {
      await this.onSessionReflection();
    }

    // Check if lifetime evolution is due
    if (this.conversationCount % this.config.lifetimeEvolutionInterval === 0) {
      await this.onLifetimeEvolution();
    }
  }

  /** Session-level reflection: patterns, what worked, what didn't */
  private async onSessionReflection(): Promise<void> {
    const recentMemory = await this.rt.memory.read('memory/MEMORY.md') ?? '';
    const recentLessons = recentMemory.split('\n### Lesson').slice(-5).join('\n### Lesson');

    if (!recentLessons.trim()) return;

    const reflection = await this.rt.llm.complete(
      `You are reflecting on your recent interactions to improve yourself.\n\n` +
      `Recent lessons:\n${recentLessons.slice(0, 1500)}\n\n` +
      `In 2-3 bullet points, what patterns do you see? What should you do differently?\n` +
      `Focus on actionable changes to your behavior.`,
    );

    await this.rt.memory.append(
      'memory/MEMORY.md',
      `\n## Session reflection (${isoDate()})\n${reflection}\n`,
    );
    await this.rt.memory.index('memory/MEMORY.md');

    this.emit({ type: 'reflection', message: `Session reflection: ${reflection.slice(0, 100)}...` });

    // Propose scaffold mutation after enough conversations with clear patterns
    if (this.conversationCount >= 3) {
      await this.maybeEvolveScaffold(reflection);
    }
  }

  /** Propose a scaffold improvement based on session patterns */
  private async maybeEvolveScaffold(reflection: string): Promise<void> {
    try {
      const scaffoldExists = await this.rt.identity.scaffold.exists();
      if (!scaffoldExists) return;

      // Skip if a pending scaffold is already in flight — consecutive sessions
      // would otherwise orphan earlier pending versions. The current pending
      // must be resolved (promoted or rolled back) before a new proposal.
      const pending = this.rt.storage.sql<{ version: number }>`
        SELECT version FROM scaffold_versions WHERE status = 'pending' LIMIT 1
      `;
      if (pending.length > 0) {
        this.emit({
          type: 'scaffold_proposed',
          message: `Skipped — scaffold v${pending[0].version} is still pending shadow evaluation`,
        });
        return;
      }

      const currentScaffold = await this.rt.identity.scaffold.read();
      if (!currentScaffold || currentScaffold.length < 50) return;

      const proposed = await this.rt.llm.complete(
        `Current agent scaffold (the agentic loop):\n\`\`\`js\n${currentScaffold}\n\`\`\`\n\n` +
        `Based on these session patterns:\n${reflection.slice(0, 500)}\n\n` +
        `Propose an improved scaffold. The scaffold MUST:\n` +
        `1. Export an async generator function: async function* run(rt, task)\n` +
        `2. Use only rt.* methods (rt.llm, rt.memory, rt.executor, rt.schedule)\n` +
        `3. NOT use import, require, eval, Function, globalThis\n` +
        `4. Be a self-contained agentic loop\n\n` +
        `Return ONLY the JavaScript code, no explanation.`,
      );

      // Only attempt mutation if the LLM produced something that looks like a scaffold
      if (!proposed.includes('async function* run')) return;

      // Extract just the code from potential markdown fences
      const code = proposed.replace(/```(?:js|javascript)?\n?/g, '').replace(/```\n?$/g, '').trim();

      const rationale = `Session reflection: ${reflection.slice(0, 100)}`;
      const result = await modifyScaffold(this.rt, rationale, code);
      if (result.ok) {
        this.emit({ type: 'scaffold_proposed', message: `Scaffold evolved to v${result.version}: ${reflection.slice(0, 60)}` });
      }
    } catch {
      // Scaffold mutation failed validation — that's fine, skip silently
    }
  }

  // ── Timescale 3: Lifetime-level (periodic background evolution) ──

  /**
   * Run a full MCTS evolution cycle. Happens automatically every N conversations.
   * Also callable manually via `proteus evolve`.
   */
  async onLifetimeEvolution(session?: SessionWriter): Promise<void> {
    const purpose = summarizeSoul(readSoul(this.rt.storage.sql)) || 'be a helpful assistant';

    this.emit({
      type: 'mcts_started',
      message: `Starting evolution cycle (budget=${this.config.lifetimeMCTSBudget})...`,
    });

    // CraftStore consolidation first
    await periodicCraftConsolidation(this.rt);
    this.emit({ type: 'consolidation', message: 'CraftStore consolidation complete' });

    // Build a session writer if not provided — enables auto-lifetime MCTS
    const writer = session ?? this.createInternalSessionWriter();

    const task = `Given my purpose: "${purpose}", identify one specific improvement ` +
      `to be more effective. Consider: new tools, knowledge gaps, workflow improvements.`;

    try {
      const result = await runMCTS(this.rt, writer, task, {
        budget: this.config.lifetimeMCTSBudget,
        branches: this.config.lifetimeMCTSBranches,
        onIterationComplete: this.config.onMctsProgress,
      });

      this.emit({
        type: 'mcts_complete',
        message: `Evolution ${result.converged ? 'converged' : 'explored'} (score: ${result.winnerValue.toFixed(2)})`,
        data: result,
      });
    } catch (err) {
      this.emit({
        type: 'mcts_complete',
        message: `Evolution failed: ${(err as Error).message}`,
      });
    }
  }

  /** Minimal in-memory session writer for auto-triggered MCTS */
  private createInternalSessionWriter(): SessionWriter {
    const messages: Array<{ id: string; parentId: string | null; role: string; content: string }> = [];
    return {
      async appendMessage(msg, parentId) {
        const content = msg.parts.map(p => p.text).join('');
        messages.push({ id: msg.id, parentId: parentId ?? null, role: msg.role, content });
      },
      getHistory(leafId) {
        if (!leafId) return messages.map(m => ({ role: m.role, content: m.content }));
        const result: Array<{ role: string; content: string }> = [];
        let current = messages.find(m => m.id === leafId);
        while (current) {
          result.unshift({ role: current.role, content: current.content });
          current = current.parentId ? messages.find(m => m.id === current!.parentId) : undefined;
        }
        return result;
      },
      async compact() {},
    };
  }

  // ── Internal helpers ────────────────────────────────────────────

  /** Assess turn quality using judge model or heuristics */
  private async assessTurnQuality(turn: CompletedTurn): Promise<number> {
    if (turn.hadError) return 0.1;
    if (turn.feedback) return feedbackToQuality(turn.feedback);

    // No explicit feedback — use heuristic: length, tool usage, error-free
    const hasSubstance = turn.assistantResponse.length > 50;
    const usedTools = turn.toolCalls.length > 0;
    const wasFast = turn.durationMs < 30_000;

    let score = 0.5;
    if (hasSubstance) score += 0.1;
    if (usedTools) score += 0.15;
    if (wasFast) score += 0.05;
    if (turn.assistantResponse.length > 500) score += 0.1;

    return Math.min(1, score);
  }

  /** Generate a reflection on a low-quality turn */
  private async generateTurnReflection(turn: CompletedTurn, quality: number): Promise<string> {
    const summary = turn.assistantResponse.slice(0, 300);
    const toolSummary = turn.toolCalls.length > 0
      ? `Tools used: ${turn.toolCalls.map(tc => tc.name).join(', ')}`
      : 'No tools used';

    return this.rt.llm.complete(
      `A recent interaction scored ${quality.toFixed(2)}/1.0 quality.\n` +
      `User asked: "${turn.userMessage.slice(0, 200)}"\n` +
      `Response: "${summary}"\n` +
      `${toolSummary}\n` +
      `${turn.hadError ? 'An error occurred.' : ''}\n\n` +
      `In one sentence, what specifically should be done differently next time?`,
    );
  }

  /** Extract a successful tool usage pattern into a reusable crafted tool.
   *  Pure-lookup calls (memory.search, fact.recall) are skipped — they read
   *  state but encode no reusable pattern.
   */
  private async extractPattern(turn: CompletedTurn, quality: number = 0.7): Promise<void> {
    const isPureLookup = (tc: { name: string; args: Record<string, unknown> }): boolean =>
      (tc.name === 'memory' && tc.args.action === 'search') ||
      (tc.name === 'fact' && tc.args.action === 'recall');
    const meaningfulCalls = turn.toolCalls.filter(tc => !isPureLookup(tc));
    if (meaningfulCalls.length === 0) return;

    const callSummary = meaningfulCalls
      .map(tc => `${tc.name}(${JSON.stringify(tc.args).slice(0, 200)}) → ${JSON.stringify(tc.result).slice(0, 200)}`)
      .join('\n');

    // Ask the LLM to generalize into a reusable function
    const generalized = await this.rt.llm.complete(
      `A successful interaction used these tool calls:\n${callSummary}\n\n` +
      `The user asked: "${turn.userMessage.slice(0, 200)}"\n\n` +
      `Extract a reusable pattern as a JavaScript async arrow function.\n` +
      `{"name":"snake_case_name","description":"one line description","params":{"type":"object","properties":{...},"required":[...]},"code":"async (args) => { ... }"}\n` +
      `The code must be a self-contained async arrow function that takes an args object.\n` +
      jsonObjectOnlyInstruction(),
    );

    try {
      const parsed = extractJsonObject(generalized) as { name?: string; description?: string; code?: string; params?: unknown };
      if (!parsed.name || !parsed.code || parsed.code.startsWith('//')) return;

      await upsertCraftedTool(this.rt, {
        name: parsed.name,
        description: parsed.description ?? '',
        code: parsed.code,
        score: quality,
      });

      this.emit({
        type: 'craft_discovered',
        message: `Discovered pattern: ${(parsed.description ?? parsed.name).slice(0, 60)}`,
      });
    } catch {
      // LLM returned invalid JSON or conflict — skip
    }
  }
}
