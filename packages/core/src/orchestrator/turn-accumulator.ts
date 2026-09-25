// Per-turn accounting shared by both backends; platform side-effects inject as optional sinks.
// Usage arrives already normalized: absence means the provider said nothing, zero means zero.

import type { ModelMessage } from 'ai';
import type { ToolCallRecord } from '../evolution/types';
import { TurnContextBudget, citesSpillAddress } from '../context-budget';
import type { ContextComposition } from '../context-meter';
import { FAILURE_WITHOUT_ERROR, type RunEventInput } from '../events/types';
import { TurnFileLedger } from '../vfs/file-ledger';
import { TurnEscalationLedger } from '../execution/escalation';
import { renderToolResult } from '../utils/evidence-window';
import { priceCall, type MissionGovernor } from '../mission-budget';
import { USAGE_FIELDS, addUsage, usageReported, usageTotal, type Usage } from '../usage';
import * as v from 'valibot';
import { digestJsonValue, projectJsonValue, type JsonObject, type JsonValue } from '../utils/json';
import { ToolOutcomeSchema, type ToolOutcome } from '../tools/outcome';
import type { CallAccount } from '../providers/quota';

const UndefinedSchema = v.undefined();

const StringSchema = v.string();

/** The subset of an ai-SDK v6 StepResult the accounting reads, usage already normalized. */
export interface StepLike {
  text?: string;
  finishReason?: unknown;
  toolCalls?: ReadonlyArray<{ toolName?: string; name?: string }>;
  toolResults?: ReadonlyArray<unknown>;
  /** Normalized by the caller holding the SDK object; carries fields no SDK type expresses. */
  usage?: Usage;
  /** `messages` is cumulative across the turn; the per-step delta is taken here. */
  response?: { modelId?: string; messages?: readonly ModelMessage[] };
  /** The request body this step sent and when; a cache warm replays the turn's last one. */
  request?: { body?: unknown; sentAt?: number };
  account?: CallAccount | undefined;
  /** The breakdown of the request this step sent. */
  context?: ContextComposition;
  /** The fallback spec that served this step; absent for the turn's own model. */
  fallback?: string | undefined;
}

/** ai-SDK v6 tool-result hook shape. */
export type ToolResultLike = ToolOutcome & {
  toolCallId: string;
  toolName: string;
  input?: JsonObject;
  durationMs?: number;
  output?: JsonValue;
  error?: Parameters<typeof describeToolFailure>[0]['error'];
};

export interface TurnSinks {
  logActivity?(event: string, detail?: string): void;
  onToolCallEvent?(e: Omit<Extract<RunEventInput, { type: 'tool_call_end' }>, 'type'>): void;
  /** The one per-step durable write; absent fields are never fabricated. */
  onStepEvent?(e: Omit<Extract<RunEventInput, { type: 'step_finish' }>, 'type'>): void;
}

/** Never empty: the ledger's failure discriminator is a non-empty string. */
function describeToolFailure(input: { error: unknown }): string {
  const { error } = input;

  if (error instanceof Error) return error.message || FAILURE_WITHOUT_ERROR;

  if (error === null || error === undefined) return FAILURE_WITHOUT_ERROR;

  return renderToolResult(error) || FAILURE_WITHOUT_ERROR;
}

export class TurnAccumulator {
  toolCalls: Array<ToolCallRecord & { outcome: ToolOutcome }> = [];
  stepCount = 0;
  /** `{}` means no step reported anything, not zeros. */
  usage: Usage = {};
  /** Prompt tokens of the last reporting step; `undefined` stays distinct from a reported 0. */
  lastPromptTokens: number | undefined = undefined;
  /** Last step's `finishReason`; `classifyRunEnd` reads `'tool-calls'` as stopped mid-work. */
  lastFinishReason: string | undefined = undefined;
  /** The turn's last request, for providers/cache-warming.ts. Held by reference, never copied. */
  lastRequest: { readonly body: unknown; readonly sentAt: number; readonly usage: Usage } | undefined = undefined;
  hadError = false;
  firstChunkSeen = false;
  startedAt = 0;
  readonly context = new TurnContextBudget();
  readonly files = new TurnFileLedger();
  readonly escalations = new TurnEscalationLedger();
  /** Written by craft-cycle.ts: crafted tools run inside `eval`, never as `toolCalls` names. */
  private readonly craftUsed = new Set<string>();
  /** Messages already durable; a shorter array is a re-drive, resynced without recording the step twice. */
  private durableMessages = 0;

  constructor(
    private readonly sinks: TurnSinks = {},
    private readonly budget?: MissionGovernor,
  ) {}

  reset(now: number): void {
    this.toolCalls = [];
    this.stepCount = 0;
    this.usage = {};
    this.lastPromptTokens = undefined;
    this.lastRequest = undefined;
    this.lastFinishReason = undefined;
    this.hadError = false;
    this.firstChunkSeen = false;
    this.startedAt = now;
    this.context.reset();
    this.files.reset();
    this.escalations.reset();
    this.craftUsed.clear();
    this.durableMessages = 0;
  }

  noteCraftedToolUse(names: readonly string[]): void {
    for (const name of names) this.craftUsed.add(name);
  }

  craftedToolsUsed(): string[] {
    return [...this.craftUsed];
  }

  /** `undefined` when no step reported anything; a reported zero comes back as one. */
  reportedUsage(): Usage | undefined {
    return usageReported(this.usage) ? this.usage : undefined;
  }

  onFirstChunk(): void {
    if (this.firstChunkSeen) return;
    this.firstChunkSeen = true;
    this.sinks.logActivity?.('first_chunk');
  }

  recordToolCall(c: ToolResultLike): void {
    // One failure description for both the core record and the durable event.
    const failure = c.success === false
      ? describeToolFailure({ error: c.error })
      : null;

    const recorded = failure !== null ? { error: failure } : c.output;
    const outcome = v.parse(ToolOutcomeSchema, c);

    if (!c.success) this.hadError = true;

    if (citesSpillAddress(c.input)) this.context.noteFollowUp();
    const dur = c.durationMs != null ? ` (${c.durationMs}ms)` : '';
    this.sinks.logActivity?.('tool_call_end', `${c.toolName}${dur}`);
    this.toolCalls.push({ toolCallId: c.toolCallId, name: c.toolName, args: c.input ?? {}, result: recorded, outcome });

    const event: Omit<Extract<RunEventInput, { type: 'tool_call_end' }>, 'type'> = {
      name: c.toolName,
      toolCallId: c.toolCallId,
      outcome,
    };

    if (c.input !== undefined) {
      const args = digestJsonValue({ value: c.input });

      if (args !== undefined) event.args = args;
    }

    if (!v.safeParse(UndefinedSchema, recorded).success) {
      event.result = projectJsonValue({ value: recorded });
    }

    if (failure !== null) event.error = failure;

    if (c.durationMs !== undefined) event.durationMs = c.durationMs;
    this.sinks.onToolCallEvent?.(event);
  }

  /** A step that reported nothing leaves the previous value standing; a reported 0 overwrites. */
  private noteLastRequest(ctx: StepLike, usage: Usage): void {
    if (usage.input !== undefined) this.lastPromptTokens = usage.input;

    const sent = ctx.request;

    if (sent?.body !== undefined && sent.sentAt !== undefined) {
      this.lastRequest = { body: sent.body, sentAt: sent.sentAt, usage };
    }
  }

  recordStep(ctx: StepLike): void {
    this.stepCount++;
    const toolCalls = Array.isArray(ctx.toolCalls) ? ctx.toolCalls : [];
    const toolResults = Array.isArray(ctx.toolResults) ? ctx.toolResults : [];
    const toolCallNames = toolCalls.map((tc) => tc?.toolName ?? tc?.name ?? '?').join(',');
    const derivedStepType = toolCalls.length > 0 ? 'tool-call' : 'text';
    const textLen = (ctx.text ?? '').length;
    const usage: Usage = ctx.usage ?? {};
    const reported = usageReported(usage);
    this.usage = addUsage(this.usage, usage);

    // Debit only a real report. `cacheRead`/`cacheWrite` are subsets of `input`.
    if (reported) this.budget?.debit(usageTotal(usage) ?? 0, { calls: 1, usage, spec: ctx.fallback });

    this.noteLastRequest(ctx, usage);

    // Every reported field, zeros included: `cacheRead=0` is a cold prefix, not silence.

    const extras: string[] = [];

    for (const field of USAGE_FIELDS) {
      const value = usage[field];

      if (value !== undefined) extras.push(`${field}=${value}`);
    }

    if (ctx.response?.modelId) extras.push(`model=${ctx.response.modelId}`);
    const extrasStr = extras.length > 0 ? ` ${extras.join(' ')}` : '';
    this.sinks.logActivity?.(
      'step_finish',
      `step ${this.stepCount} kind=${derivedStepType} reason=${String(ctx.finishReason)} ` +
      `textLen=${textLen} tools=${toolCalls.length}[${toolCallNames}] results=${toolResults.length}` +
      extrasStr,
    );
    // An empty array means no response reported (scaffold step boundary); never rewind on it.
    const cumulative = ctx.response?.messages ?? [];
    const produced = cumulative.length > 0 ? cumulative.slice(this.durableMessages) : [];

    if (cumulative.length > 0) this.durableMessages = cumulative.length;

    const stepEvent: Parameters<NonNullable<TurnSinks['onStepEvent']>>[0] = {
      stepIndex: this.stepCount,
      account: ctx.account,
    };

    const reason = v.safeParse(StringSchema, ctx.finishReason);

    if (reason.success) {
      stepEvent.reason = reason.output;
      this.lastFinishReason = reason.output;
    }

    if (produced.length > 0) stepEvent.messages = [...produced];

    if (ctx.context) stepEvent.context = ctx.context;

    // Priced as the mission ledger prices it, at the serving model's rate; no rate means no `usd`.
    if (reported) {
      stepEvent.usage = usage;
      const pricing = this.budget?.pricing(ctx.fallback) ?? null;
      const usd = pricing ? priceCall(usage, pricing) : undefined;

      if (usd !== undefined) stepEvent.usd = usd;

      const modelId = v.safeParse(StringSchema, ctx.response?.modelId);

      if (modelId.success && modelId.output.length > 0) stepEvent.modelId = modelId.output;
    }


    this.sinks.onStepEvent?.(stepEvent);
  }
}
