// Per-turn accounting shared by both backends; platform side-effects inject as optional sinks.
// Usage arrives already normalized: absence means the provider said nothing, zero means zero.

import type { ModelMessage } from 'ai';
import type { ChatEvent, StepRecord } from '../chat';
import type { ToolCallRecord } from '../evolution/types';
import { compactToolCall } from '../evolution/tool-call-record';
import { TurnContextBudget, citesSpillAddress } from '../context-budget';
import type { ContextComposition } from '../context-meter';
import { FAILURE_WITHOUT_ERROR, type RunEventInput } from '../events/types';
import { TurnFileLedger } from '../vfs/file-ledger';
import { TurnEscalationLedger } from '../execution/escalation';
import { renderToolResult } from '../utils/evidence-window';
import { priceCall, type MissionGovernor, type SpendGate } from '../mission-budget';
import { USAGE_FIELDS, addUsage, usageReported, usageTotal, type Usage } from '../usage';
import * as v from 'valibot';
import { digestJsonValue, projectJsonValue, type JsonObject, type JsonValue } from '../utils/json';
import { ToolOutcomeSchema, type ToolOutcome } from '../tools/outcome';
import type { CallAccount } from '../providers/quota';

/** The subset of an ai-SDK v6 StepResult the accounting reads, usage already normalized. */
export interface StepLike {
  text?: string;
  finishReason?: string | undefined;
  toolCalls?: ReadonlyArray<{ toolName?: string; name?: string }>;
  toolResults?: ReadonlyArray<unknown>;
  /** Normalized by the caller holding the SDK object; carries fields no SDK type expresses. */
  usage?: Usage;
  /** The prompt the step's request answered from, where it differs from `usage.input` (a server-side compaction). */
  promptTokens?: number;
  /** `messages` is cumulative across the turn; the per-step delta is taken here. */
  response?: { modelId?: string; messages?: readonly ModelMessage[] };
  /** The request body this step sent and when; a cache warm replays the turn's last one. */
  request?: { body?: unknown; sentAt?: number };
  account?: CallAccount | undefined;
  egress?: string | undefined;
  /** The breakdown of the request this step sent. */
  context?: ContextComposition;
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
  toolCalls: ToolCallRecord[] = [];
  stepCount = 0;
  /** `{}` means no step reported anything, not zeros. */
  usage: Usage = {};
  /** Prompt tokens of the last reporting step; `undefined` stays distinct from a reported 0. */
  lastPromptTokens: number | undefined = undefined;
  /** Last step's `finishReason`; `classifyRunEnd` reads `'tool-calls'` as stopped mid-work. */
  lastFinishReason: string | undefined = undefined;
  /** The turn's last request, for providers/cache-warming.ts. Held by reference, never copied. */
  /** `fallback`: the spec that served it, where a fallback did. */
  lastRequest: { readonly body: unknown; readonly sentAt: number; readonly usage: Usage; readonly fallback: string | undefined } | undefined = undefined;
  hadError = false;
  firstChunkSeen = false;
  startedAt = 0;
  readonly context = new TurnContextBudget();
  readonly files = new TurnFileLedger();
  readonly escalations = new TurnEscalationLedger();
  /** Written by craft-cycle.ts: crafted tools run inside `eval`, never as `toolCalls` names. */
  private readonly craftUsed = new Set<string>();
  /** The tool lessons a step listed, id to the revision shown. */
  private readonly lessons = new Map<string, number>();
  /** Messages already durable; a shorter array is a re-drive, resynced without recording the step twice. */
  private durableMessages = 0;

  private gate: SpendGate | undefined;

  constructor(
    private readonly sinks: TurnSinks = {},
    private readonly budget?: MissionGovernor,
  ) {}

  private get charged(): SpendGate | undefined {
    return this.gate ?? this.budget;
  }

  chargeTo(gate: SpendGate | undefined): () => void {
    this.gate = gate;

    return () => { this.gate = undefined; };
  }

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
    this.lessons.clear();
    this.durableMessages = 0;
  }

  /** Restores totals without charging them again. */
  resume(steps: number, usage: Usage): void {
    this.stepCount = steps;
    this.usage = usage;
  }

  noteCraftedToolUse(names: readonly string[]): void {
    for (const name of names) this.craftUsed.add(name);
  }

  craftedToolsUsed(): string[] {
    return [...this.craftUsed];
  }

  noteLessonsShown(lessons: readonly { readonly id: string; readonly revision: number }[]): void {
    for (const lesson of lessons) this.lessons.set(lesson.id, lesson.revision);
  }

  lessonsShown(): { id: string; revision: number }[] {
    return [...this.lessons].map(([id, revision]) => ({ id, revision }));
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
    this.writeToolCall(c)();
  }

  recordResult(args: JsonObject, event: Extract<ChatEvent, { type: 'tool-result' }>): void {
    this.recordToolCall({ input: args, ...event, output: event.output ?? (event.success ? event.result : undefined),
      error: event.error ?? (event.success ? undefined : event.result) });
  }

  recordBoundary(event: Extract<ChatEvent, { type: 'step-finish' }>): void {
    this.recordStep({ ...event, response: { messages: event.responseMessages, modelId: event.modelId } });
  }

  writeNative(record: StepRecord): () => void {
    const committed = record.toolResults.map(({ event, args }) => this.writeToolCall({
      input: args,
      ...event, output: event.output ?? (event.success ? event.result : undefined), error: event.error ?? (event.success ? undefined : event.result),
    }));

    if (record.step !== undefined) {
      const step = record.step;
      committed.push(this.writeStep({
        ...step, response: { messages: record.messages, modelId: step.modelId }, request: step.request,
      }));
    }

    return () => { for (const commit of committed) commit(); };
  }

  writeToolCall(c: ToolResultLike): () => void {
    // One failure description for both the core record and the durable event.
    const failure = c.success === false
      ? describeToolFailure({ error: c.error })
      : null;

    const recorded = failure !== null ? { error: failure } : c.output;
    const outcome = v.parse(ToolOutcomeSchema, c);
    const call = compactToolCall({ toolCallId: c.toolCallId, name: c.toolName, args: c.input ?? {}, result: recorded, outcome });
    const failed = !c.success;
    const followUp = citesSpillAddress(c.input);

    const dur = c.durationMs != null ? ` (${c.durationMs}ms)` : '';

    const event: Omit<Extract<RunEventInput, { type: 'tool_call_end' }>, 'type'> = {
      name: c.toolName,
      toolCallId: c.toolCallId,
      outcome,
    };

    if (c.input !== undefined) {
      const args = digestJsonValue({ value: c.input });

      if (args !== undefined) event.args = args;
    }

    if (recorded !== undefined) {
      event.result = projectJsonValue({ value: recorded });
    }

    if (failure !== null) event.error = failure;

    if (c.durationMs !== undefined) event.durationMs = c.durationMs;

    this.sinks.onToolCallEvent?.(event);

    return () => {
      if (failed) this.hadError = true;

      if (followUp) this.context.noteFollowUp();
      this.sinks.logActivity?.('tool_call_end', `${call.name}${dur}`);
      this.toolCalls.push(call);
    };
  }

  /** A step that reported nothing leaves the previous value standing; a reported 0 overwrites. */
  private noteLastRequest(ctx: StepLike, usage: Usage): void {
    const prompt = ctx.promptTokens ?? usage.input;

    if (prompt !== undefined) this.lastPromptTokens = prompt;

    const sent = ctx.request;

    if (sent?.body !== undefined && sent.sentAt !== undefined) {
      this.lastRequest = { body: sent.body, sentAt: sent.sentAt, usage, fallback: ctx.fallback };
    }
  }

  recordStep(ctx: StepLike): void {
    this.writeStep(ctx)();
  }

  writeStep(ctx: StepLike): () => void {
    const stepCount = this.stepCount + 1;
    const toolCalls = Array.isArray(ctx.toolCalls) ? ctx.toolCalls : [];
    const toolResults = Array.isArray(ctx.toolResults) ? ctx.toolResults : [];
    const toolCallNames = toolCalls.map((tc) => tc?.toolName ?? tc?.name ?? '?').join(',');
    const derivedStepType = toolCalls.length > 0 ? 'tool-call' : 'text';
    const textLen = (ctx.text ?? '').length;
    const usage: Usage = ctx.usage ?? {};
    const reported = usageReported(usage);

    // Debit only a real report. `cacheRead`/`cacheWrite` are subsets of `input`.
    if (reported) this.charged?.debit(usageTotal(usage) ?? 0, { calls: 1, usage, spec: ctx.fallback });


    // Every reported field, zeros included: `cacheRead=0` is a cold prefix, not silence.

    const extras: string[] = [];

    for (const field of USAGE_FIELDS) {
      const value = usage[field];

      if (value !== undefined) extras.push(`${field}=${value}`);
    }

    if (ctx.response?.modelId) extras.push(`model=${ctx.response.modelId}`);
    const extrasStr = extras.length > 0 ? ` ${extras.join(' ')}` : '';
    // An empty array means no response reported (scaffold step boundary); never rewind on it.
    const cumulative = ctx.response?.messages ?? [];
    const produced = cumulative.length > 0 ? cumulative.slice(this.durableMessages) : [];

    const stepEvent: Parameters<NonNullable<TurnSinks['onStepEvent']>>[0] = {
      stepIndex: stepCount,
      account: ctx.account,
      egress: ctx.egress,
    };

    if (ctx.finishReason !== undefined) {
      stepEvent.reason = ctx.finishReason;
    }

    if (produced.length > 0) stepEvent.messages = [...produced];

    if (ctx.context) stepEvent.context = ctx.context;

    // Priced as the mission ledger prices it, at the serving model's rate; no rate means no `usd`.
    if (reported) {
      stepEvent.usage = usage;
      const pricing = this.budget?.pricing(ctx.fallback);
      const usd = pricing ? priceCall(usage, pricing) : undefined;

      if (usd !== undefined) stepEvent.usd = usd;

      const modelId = ctx.response?.modelId;

      if (modelId) stepEvent.modelId = modelId;
    }


    this.sinks.onStepEvent?.(stepEvent);

    return () => {
      this.stepCount = stepCount;
      this.usage = addUsage(this.usage, usage);
      this.noteLastRequest(ctx, usage);

      if (cumulative.length > 0) this.durableMessages = cumulative.length;

      if (ctx.finishReason !== undefined) this.lastFinishReason = ctx.finishReason;

      this.sinks.logActivity?.('step_finish', `step ${stepCount} kind=${derivedStepType} reason=${String(ctx.finishReason)} ` +
        `textLen=${textLen} tools=${toolCalls.length}[${toolCallNames}] results=${toolResults.length}${extrasStr}`);
    };
  }
}
