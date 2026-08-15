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
import { TurnContextMeter, type ContextComposition } from '../context-meter.js';
import type { RunEventInput, StepUsage } from '../events/types.js';
import { TurnFileLedger } from '../tools/file-ledger.js';
import { priceCall, type MissionGovernor } from '../mission-budget.js';
import * as v from 'valibot';
import { projectJsonValue, type JsonObject, type JsonValue } from '../utils/json.js';

const UndefinedSchema = v.undefined();
const StringSchema = v.string();

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
  input?: JsonObject;
  durationMs?: number;
  success: boolean;
  output?: JsonValue;
  error?: unknown;
}

/** Platform side-effects the accounting fires — both optional so a pure consumer
 *  (tests, a minimal CLI) can omit them. */
export interface TurnSinks {
  /** Human-readable activity line (cf: activity_log row; cli: debug log). */
  logActivity?(event: string, detail?: string): void;
  /** A completed tool call, for a durable run-event log (cf RunEventRecorder). */
  onToolCallEvent?(e: Omit<Extract<RunEventInput, { type: 'tool_call_end' }>, 'type'>): void;
  /** A finished step, for the durable run-event log. `usage` is the provider's
   *  own report; `context` is the local measurement of the request that
   *  produced it. Either may be absent — neither is ever fabricated. */
  onStepEvent?(e: {
    stepIndex: number;
    reason?: string;
    usage?: StepUsage;
    context?: ContextComposition;
  }): void;
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
  /** What the turn has read and what its `file` edits did. Handed to the
   *  toolset so an edit can refuse to run blind, and read at turn end for the
   *  durable `file_edit` row. Reset with the rest of the turn. */
  readonly files = new TurnFileLedger();
  /** What each of the turn's requests was made of. Handed to the step pipeline
   *  (the one holder of the final composed array) and drained here, so a
   *  measurement is always reported against the usage of the very request it
   *  measured rather than the next one. Reset with the rest of the turn. */
  readonly composition = new TurnContextMeter();
  /** The crafted tools this turn called. Written by the in-episode craft clock
   *  (orchestrator/craft-cycle.ts), which is the only thing that can see them:
   *  a crafted tool is reached from inside an `execute_tools` block, so it is
   *  never a `toolCalls` name. Read at turn end for the craft EMA and the
   *  durable turn↔craft usage row. Reset with the rest of the turn. */
  private readonly craftUsed = new Set<string>();

  constructor(
    private readonly sinks: TurnSinks = {},
    /** The actor's mission governor. Present or not, the accounting is the
     *  same — the governor simply also debits the active mission scope from
     *  the numbers this already counts, so there is one usage measurement. */
    private readonly budget?: MissionGovernor,
  ) {}

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
    this.files.reset();
    this.composition.reset();
    this.craftUsed.clear();
  }

  /** Record crafted tools the turn invoked — the craft clock's call-site scan
   *  of a settled `execute_tools` block, deduped across the turn. */
  noteCraftedToolUse(names: readonly string[]): void {
    for (const name of names) this.craftUsed.add(name);
  }

  /** The crafted tools this turn called, in first-observed order. */
  craftedToolsUsed(): string[] {
    return [...this.craftUsed];
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
    this.toolCalls.push({ name: c.toolName, args: c.input ?? {}, result: recorded });
    const event: Omit<Extract<RunEventInput, { type: 'tool_call_end' }>, 'type'> = {
      name: c.toolName,
      toolCallId: `tc-${this.toolCalls.length}`,
    };
    if (!v.safeParse(UndefinedSchema, recorded).success) {
      event.result = projectJsonValue({ value: recorded });
    }
    if (c.success === false) event.error = String(c.error ?? '');
    if (c.durationMs !== undefined) event.durationMs = c.durationMs;
    this.sinks.onToolCallEvent?.(event);
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
    // The model-call debit, taken from the provider's own report of the step
    // just paid for. `cached` is a subset of `inputTokens` (ai v6 reports the
    // cache-inclusive total), so it is not added again — but it IS handed over
    // so the ledger can charge it at the model's cache-read rate.
    this.budget?.debit(inTok + outTok, {
      calls: 1,
      usage: { input: inTok, output: outTok, cached: cached > 0 ? cached : undefined },
    });
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
    // The provider's own report of this request, priced at the catalog rate
    // the model carried when the call was made — the same rate and the same
    // arithmetic the mission ledger debits with, so one step never costs two
    // different amounts depending on who asks. No rate means no `usd`: an
    // unpriced step is reported unpriced rather than blended into a number
    // that looks like a measurement.
    const pricing = this.budget?.pricing() ?? null;
    const reported = inTok > 0 || outTok > 0;
    let stepUsage: StepUsage | undefined;
    if (reported) {
      const modelId = v.safeParse(StringSchema, ctx.response?.modelId);
      const baseUsage = {
        input: inTok,
        output: outTok,
        cached,
        reasoning,
      };
      const pricedUsd = pricing
        ? priceCall({ input: inTok, output: outTok, cached }, pricing)
        : null;
      const reportedModel = modelId.success && modelId.output.length > 0
        ? modelId.output
        : null;
      if (pricedUsd !== null && reportedModel !== null) {
        stepUsage = { ...baseUsage, usd: pricedUsd, modelId: reportedModel };
      } else if (pricedUsd !== null) {
        stepUsage = { ...baseUsage, usd: pricedUsd };
      } else if (reportedModel !== null) {
        stepUsage = { ...baseUsage, modelId: reportedModel };
      } else {
        stepUsage = baseUsage;
      }
    }
    const composition = this.composition.take();
    const stepEvent: Parameters<NonNullable<TurnSinks['onStepEvent']>>[0] = {
      stepIndex: this.stepCount,
    };
    const reason = v.safeParse(StringSchema, ctx.finishReason);
    if (reason.success) stepEvent.reason = reason.output;
    if (stepUsage) stepEvent.usage = stepUsage;
    if (composition) stepEvent.context = composition;
    this.sinks.onStepEvent?.(stepEvent);
  }
}
