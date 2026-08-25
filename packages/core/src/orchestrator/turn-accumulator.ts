// TurnAccumulator — the per-turn accounting slice of the backend-agnostic agent.
//
// Both backends do the same bookkeeping inside the inference loop: collect the
// turn's tool calls, count steps, accumulate the provider's usage report, and
// flag errors. This was duplicated as `_turn*` fields + hook bodies on the
// cf-backend OrchestratorAgent and inline in the CLI chat loop. Hoisted here so
// there is ONE tested implementation; platform side-effects (activity log,
// durable run-event recorder) inject as optional sinks.
//
// Nothing here knows the AI SDK's usage dialect: a step arrives with its usage
// already normalized (`normalizeUsage` at the seam that holds the SDK object),
// so absence means the provider said nothing and a zero means it said zero all
// the way through to the ledger.

import type { ModelMessage } from 'ai';
import type { ToolCallRecord } from '../evolution/types';
import { TurnContextBudget, citesSpillAddress } from '../context-budget';
import { TurnContextMeter } from '../context-meter';
import { FAILURE_WITHOUT_ERROR, type RunEventInput } from '../events/types';
import { TurnFileLedger } from '../tools/file-ledger';
import { TurnEscalationLedger } from '../execution/escalation';
import { priceCall, type MissionGovernor } from '../mission-budget';
import { USAGE_FIELDS, addUsage, usageReported, usageTotal, type Usage } from '../usage';
import * as v from 'valibot';
import { digestJsonValue, projectJsonValue, type JsonObject, type JsonValue } from '../utils/json';

const UndefinedSchema = v.undefined();
const StringSchema = v.string();

/** A finished step, as the accounting reads it: the ai-SDK v6 StepResult minus
 *  the fields we don't use, with its usage already normalized. */
export interface StepLike {
  text?: string;
  finishReason?: unknown;
  toolCalls?: ReadonlyArray<{ toolName?: string; name?: string }>;
  toolResults?: ReadonlyArray<unknown>;
  /** The provider's report for THIS step's request, already normalized by the
   *  caller that held the SDK object (cf-backend's onStepFinish, core's
   *  `runChat`). A domain value, not a dialect: the two fields no SDK type can
   *  express — Anthropic's 1h cache writes and Workers AI's neurons — reach the
   *  ledger only because this is where they survive. */
  usage?: Usage;
  /** `messages` is CUMULATIVE across the turn — the SDK grows one array and
   *  hands the whole thing to every step. The per-step delta is taken here so
   *  there is one implementation of it for both backends. */
  response?: { modelId?: string; messages?: readonly ModelMessage[] };
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
  /** A finished step, for the durable run-event log — the ONE per-step durable
   *  write on both backends. Derived from the durable row so the payload cannot
   *  drift from what is stored: `messages` is what the step produced, `usage`
   *  the provider's own report, `usd` that report priced, `modelId` who served
   *  it, `context` the local measurement of the request. Any of them may be
   *  absent — none is ever fabricated. */
  onStepEvent?(e: Omit<Extract<RunEventInput, { type: 'step_finish' }>, 'type'>): void;
}

/** A failed call's error, as text that is never empty. A tool that reports
 *  `success: false` with a nullish error has still failed, and the ledger's one
 *  discriminator is a non-empty string — so the absence of a message is stated
 *  rather than rendered as the absence of a failure. */
function describeToolFailure(input: { error: unknown }): string {
  const { error } = input;
  if (error instanceof Error) return error.message || FAILURE_WITHOUT_ERROR;
  if (error === null || error === undefined) return FAILURE_WITHOUT_ERROR;
  return String(error) || FAILURE_WITHOUT_ERROR;
}

export class TurnAccumulator {
  toolCalls: ToolCallRecord[] = [];
  stepCount = 0;
  /** The turn's steps summed field by field. `{}` means no step reported
   *  anything — never a row of zeros standing in for a silent provider. */
  usage: Usage = {};
  /** Provider-reported prompt tokens of the turn's LAST reporting step — the
   *  final request's priced input size. `undefined` until a step reports one,
   *  which is what keeps it distinguishable from a reported 0. Backends persist
   *  it at turn end as the next turn's measured compaction-trigger signal. */
  lastPromptTokens: number | undefined = undefined;
  /** The `finishReason` the turn's LAST step reported, or `undefined` until a
   *  step reports one. Read at settle by `classifyRunEnd`: a step that reported
   *  `'tool-calls'` had its tool results delivered and a further step due, so a
   *  turn whose last step says that stopped while the model was still working.
   *  Four of four capped production runs sealed as `'completed'` because
   *  nothing carried this fact out of the loop. */
  lastFinishReason: string | undefined = undefined;
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
  /** Which provisioned environments the turn reached for instead of its own
   *  shell, why, and how each turned out. Handed to the toolset so the `run`
   *  dispatch can record the decision at the moment it is made, and read at turn
   *  end for the durable `execution_escalation` row. Reset with the rest of the
   *  turn. */
  readonly escalations = new TurnEscalationLedger();
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
  /** How many of the turn's cumulative response messages have already been
   *  written durably. The SDK hands every step the whole array so far; the
   *  delta is what this step produced, and it is what the step's durable row
   *  carries. Reset with the rest of the turn.
   *
   *  A shorter array than we have already written means the SDK restarted the
   *  turn (a recovery re-drive) rather than extended it: the counter resyncs
   *  downward and that step records nothing, because under-recording is safe
   *  and re-recording a step would duplicate it in the log. */
  private durableMessages = 0;

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
    this.usage = {};
    this.lastPromptTokens = undefined;
    this.lastFinishReason = undefined;
    this.hadError = false;
    this.firstChunkSeen = false;
    this.startedAt = now;
    this.context.reset();
    this.files.reset();
    this.escalations.reset();
    this.composition.reset();
    this.craftUsed.clear();
    this.durableMessages = 0;
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

  /** What the turn spent, or undefined when no step reported anything — so a
   *  turn served by a provider that reports nothing carries no usage rather
   *  than a fabricated zero. A step that reported an honest zero IS a report
   *  and comes back as one. */
  reportedUsage(): Usage | undefined {
    return usageReported(this.usage) ? this.usage : undefined;
  }

  /** First streamed token of the turn — fired once. */
  onFirstChunk(): void {
    if (this.firstChunkSeen) return;
    this.firstChunkSeen = true;
    this.sinks.logActivity?.('first_chunk');
  }

  /** A tool call completed. Records the core ToolCallRecord + fires sinks. */
  recordToolCall(c: ToolResultLike): void {
    // ONE description of the failure for both the core record and the durable
    // event. They used to disagree — `String(c.error)` here against
    // `String(c.error ?? '')` at the sink — so the same nullish error read as
    // `"undefined"` in the evolution signal and as `""` in the ledger. Empty is
    // the expensive one: every reader's predicate is `error !== ''`, so a tool
    // that reported failure without saying why was recorded as a CLEAN call,
    // while `hadError` below knew it had failed.
    const failure = c.success === false
      ? describeToolFailure({ error: c.error })
      : null;
    const recorded = failure !== null ? { error: failure } : c.output;
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
    // What the call was ASKED to do, bounded. Without it the durable row names
    // the tool and nothing else, so a ledger of 34 failures could say `file×13`
    // and never which action — and a dispatcher tool's action is the whole
    // difference between a refusal it was right to make and a defect.
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

  /** A model step finished. Accumulates usage + fires the step sinks. */
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
    // The model-call debit, taken from the provider's own report of the step
    // just paid for — and taken ONLY when there is a report: a step nothing was
    // reported for meters nothing rather than debiting a zero that would read
    // as a measurement. `cacheRead`/`cacheWrite` are subsets of `input`, so the
    // total does not add them again, but the whole report goes over so the
    // ledger can charge each part at its own rate.
    if (reported) this.budget?.debit(usageTotal(usage) ?? 0, { calls: 1, usage });
    // Each step is one request, so the newest reporting step carries the whole
    // current prompt (`input` is the cache-inclusive total). A step that
    // reported no prompt size leaves the last real measurement standing; a step
    // that reported 0 overwrites it, because that is a measurement too.
    if (usage.input !== undefined) this.lastPromptTokens = usage.input;
    // Every field the provider actually mentioned, zeros included: a reported
    // `cacheRead=0` is a cold prefix on a working cache plan, and hiding it
    // makes that indistinguishable from a provider that never mentions caching.
    // Driven off USAGE_FIELDS so a field added to the report cannot go unlogged.
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
    const composition = this.composition.take();
    // What THIS step produced: the cumulative array minus what earlier steps of
    // the same turn already made durable. An EMPTY array means the caller
    // reported no response for this step (a scaffold-authored step boundary),
    // not that the turn has produced nothing — rewinding the cursor on it would
    // make the next real step re-record everything before it.
    const cumulative = ctx.response?.messages ?? [];
    const produced = cumulative.length > 0 ? cumulative.slice(this.durableMessages) : [];
    if (cumulative.length > 0) this.durableMessages = cumulative.length;
    const stepEvent: Parameters<NonNullable<TurnSinks['onStepEvent']>>[0] = {
      stepIndex: this.stepCount,
    };
    const reason = v.safeParse(StringSchema, ctx.finishReason);
    // Kept on the accumulator as well as on the step's own row: the settle
    // classifier needs the LAST one, and the rows are durable but not readable
    // from inside the turn that is ending. A step that reported nothing
    // nameable leaves the last real reason standing, exactly as
    // `lastPromptTokens` above leaves the last real measurement standing.
    if (reason.success) {
      stepEvent.reason = reason.output;
      this.lastFinishReason = reason.output;
    }
    if (produced.length > 0) stepEvent.messages = [...produced];
    if (composition) stepEvent.context = composition;
    // The provider's own report of this request, priced at the catalog rate the
    // model carried when the call was made — the same rate and the same
    // arithmetic the mission ledger debits with, so one step never costs two
    // different amounts depending on who asks. No rate means no `usd`: an
    // unpriced step is reported unpriced rather than blended into a number that
    // looks like a measurement.
    if (reported) {
      stepEvent.usage = usage;
      const pricing = this.budget?.pricing() ?? null;
      const usd = pricing ? priceCall(usage, pricing) : undefined;
      if (usd !== undefined) stepEvent.usd = usd;
      const modelId = v.safeParse(StringSchema, ctx.response?.modelId);
      if (modelId.success && modelId.output.length > 0) stepEvent.modelId = modelId.output;
    }
    this.sinks.onStepEvent?.(stepEvent);
  }
}
