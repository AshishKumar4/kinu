// TurnAccumulator — the per-turn accounting slice of the backend-agnostic agent.
//
// Both backends do the same bookkeeping inside the inference loop: collect the
// turn's tool calls, count steps, accumulate token usage (incl. cached +
// reasoning), and flag errors. This was duplicated as `_turn*` fields + hook
// bodies on the cf-backend OrchestratorAgent and inline in the CLI chat loop.
// Hoisted here so there is ONE tested implementation; platform side-effects
// (activity log, durable run-event recorder) inject as optional sinks.

import type { ToolCallRecord, TurnUsage } from '../evolution/types.js';
import { TurnContextBudget, citesSpillAddress } from '../context-budget.js';

/** ai-SDK v6 step shape we read for accounting (loosely typed — the SDK's
 *  StepResult, minus the fields we don't use). */
export interface StepLike {
  text?: string;
  finishReason?: unknown;
  toolCalls?: ReadonlyArray<{ toolName?: string; name?: string }>;
  toolResults?: ReadonlyArray<unknown>;
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number };
  providerMetadata?: { anthropic?: { cacheReadInputTokens?: number } };
  response?: { modelId?: string };
}

/** ai-SDK v6 tool-result hook shape (Think 0.4 renamed args→input, result→output
 *  + added a success discriminator + durationMs). */
export interface ToolResultLike {
  toolName: string;
  input?: Record<string, unknown>;
  durationMs?: number;
  success: boolean;
  output?: unknown;
  error?: unknown;
}

/** Platform side-effects the accounting fires — both optional so a pure consumer
 *  (tests, a minimal CLI) can omit them. */
export interface TurnSinks {
  /** Human-readable activity line (cf: activity_log row; cli: debug log). */
  logActivity?(event: string, detail?: string): void;
  /** A completed tool call, for a durable run-event log (cf RunEventRecorder). */
  onToolCallEvent?(e: { name: string; toolCallId: string; result: unknown; error?: string; durationMs?: number }): void;
  /** A finished step, for the durable run-event log. */
  onStepEvent?(e: { stepIndex: number; reason?: string }): void;
}

export class TurnAccumulator {
  toolCalls: ToolCallRecord[] = [];
  stepCount = 0;
  usage: TurnUsage = { input: 0, output: 0, cached: 0 };
  /** Provider-reported prompt tokens of the turn's LAST step — the final
   *  request's priced input size (0 until a step reports). Backends persist
   *  it at turn end as the next turn's measured compaction-trigger signal. */
  lastPromptTokens = 0;
  hadError = false;
  firstChunkSeen = false;
  startedAt = 0;
  /** The turn's bulk-ingestion budget + trip counters. Handed to the toolset
   *  so the clamp tightens as the turn gets heavy, and read at turn end for
   *  the durable `context_budget` row. Reset with the rest of the turn. */
  readonly context = new TurnContextBudget();

  constructor(private readonly sinks: TurnSinks = {}) {}

  /** Reset for a new turn. The caller stamps backend-specific state separately. */
  reset(now: number): void {
    this.toolCalls = [];
    this.stepCount = 0;
    this.usage = { input: 0, output: 0, cached: 0 };
    this.lastPromptTokens = 0;
    this.hadError = false;
    this.firstChunkSeen = false;
    this.startedAt = now;
    this.context.reset();
  }

  /** What the turn spent, or undefined when no step reported usage — so a
   *  turn served by a provider that reports nothing carries no usage rather
   *  than a fabricated zero. */
  reportedUsage(): TurnUsage | undefined {
    const { input, output, cached } = this.usage;
    return input > 0 || output > 0 || cached > 0 ? { input, output, cached } : undefined;
  }

  /** First streamed token of the turn — fired once. */
  onFirstChunk(): void {
    if (this.firstChunkSeen) return;
    this.firstChunkSeen = true;
    this.sinks.logActivity?.('first_chunk');
  }

  /** A tool call completed. Records the core ToolCallRecord + fires sinks. */
  recordToolCall(c: ToolResultLike): void {
    const recorded = c.success === false
      ? { error: c.error instanceof Error ? c.error.message : String(c.error) }
      : c.output;
    if (c.success === false) this.hadError = true;
    // A call that names a spill address is the drop-content-keep-the-path
    // recipe being followed — the counter that says the references are read,
    // not just emitted.
    if (citesSpillAddress(c.input)) this.context.noteFollowUp();
    const dur = c.durationMs != null ? ` (${c.durationMs}ms)` : '';
    this.sinks.logActivity?.('tool_call_end', `${c.toolName}${dur}`);
    this.toolCalls.push({ name: c.toolName, args: (c.input ?? {}) as Record<string, unknown>, result: recorded });
    this.sinks.onToolCallEvent?.({
      name: c.toolName,
      toolCallId: `tc-${this.toolCalls.length}`,
      result: recorded,
      error: c.success === false ? String(c.error ?? '') : undefined,
      durationMs: c.durationMs,
    });
  }

  /** A model step finished. Accumulates usage + fires the step sinks. */
  recordStep(ctx: StepLike): void {
    this.stepCount++;
    const toolCalls = Array.isArray(ctx.toolCalls) ? ctx.toolCalls : [];
    const toolResults = Array.isArray(ctx.toolResults) ? ctx.toolResults : [];
    const toolCallNames = toolCalls.map((tc) => tc?.toolName ?? tc?.name ?? '?').join(',');
    const derivedStepType = toolCalls.length > 0 ? 'tool-call' : 'text';
    const textLen = (ctx.text ?? '').length;
    const u = ctx.usage;
    const inTok = u?.inputTokens ?? 0;
    const outTok = u?.outputTokens ?? 0;
    // Cached prefix: Workers AI / OpenAI on usage; Anthropic in providerMetadata.
    const cached = (u?.cachedInputTokens ?? 0) + (ctx.providerMetadata?.anthropic?.cacheReadInputTokens ?? 0);
    const reasoning = u?.reasoningTokens ?? 0;
    this.usage.input += inTok;
    this.usage.output += outTok;
    this.usage.cached += cached;
    // Each step is one request, so the newest reporting step carries the
    // whole current prompt (ai v6 usage.inputTokens is the cache-inclusive
    // total). Keep the last non-zero report: a trailing step with absent
    // usage must not erase a real measurement.
    if (inTok > 0) this.lastPromptTokens = inTok;
    const extras: string[] = [];
    if (cached > 0) extras.push(`cached=${cached}`);
    if (reasoning > 0) extras.push(`reasoning=${reasoning}`);
    if (ctx.response?.modelId) extras.push(`model=${ctx.response.modelId}`);
    const extrasStr = extras.length > 0 ? ` ${extras.join(' ')}` : '';
    this.sinks.logActivity?.(
      'step_finish',
      `step ${this.stepCount} kind=${derivedStepType} reason=${String(ctx.finishReason)} ` +
      `textLen=${textLen} tools=${toolCalls.length}[${toolCallNames}] results=${toolResults.length} ` +
      `in=${inTok} out=${outTok}${extrasStr}`,
    );
    this.sinks.onStepEvent?.({
      stepIndex: this.stepCount,
      reason: typeof ctx.finishReason === 'string' ? ctx.finishReason : undefined,
    });
  }
}
