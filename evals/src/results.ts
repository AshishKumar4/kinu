// The vitest JSON report `bun run evals` writes, as far as the comparison and the trajectory
// renderer read it. Every object is loose: the reporter adds fields freely and only these are relied on.
import { basename } from 'node:path';
import * as v from 'valibot';
import { BACKGROUND_POLICY, BackgroundHandleSchema, backgroundedBy, JsonValueSchema, summarizeSteps, type JsonValue, type RunEvent } from '@kinu.run/core';
import { TURN_OUTCOMES } from './task';

const JsonRecordSchema = v.record(v.string(), JsonValueSchema);

const TranscriptEventSchema = v.variant('type', [
  v.looseObject({
    type: v.literal('message'),
    role: v.picklist(['system', 'user', 'assistant']),
    content: v.optional(JsonValueSchema),
    metadata: v.optional(JsonRecordSchema),
  }),
  v.looseObject({ type: v.literal('tool_call'), id: v.string(), name: v.string(), arguments: v.optional(JsonRecordSchema) }),
  v.looseObject({
    type: v.literal('tool_result'),
    toolCallId: v.string(),
    name: v.optional(v.string()),
    content: v.optional(JsonValueSchema),
    error: v.optional(v.looseObject({ message: v.string() })),
  }),
]);

const CheckSchema = v.looseObject({ id: v.string(), pass: v.boolean(), evidence: v.optional(JsonValueSchema) });

const Count = v.pipe(v.number(), v.integer(), v.minValue(0));

const StepUsageSchema = v.object({
  actor: v.string(),
  timestamp: v.string(),
  runId: v.string(),
  stepIndex: Count,
  inputTokens: v.nullable(Count),
  outputTokens: v.nullable(Count),
  cacheReadTokens: v.nullable(Count),
  cacheWriteTokens: v.nullable(Count),
});

export type StepUsage = v.InferOutput<typeof StepUsageSchema>;

/** One tool's failed calls in a trial for one cause: the code the product refused it with, `unknown_tool` for a name
 *  it does not offer, `error` for a throw it gave no code. A binding a program called counts under its own name. */
const ToolFailureSchema = v.object({ tool: v.string(), cause: v.string(), count: Count });

export type ToolFailure = v.InferOutput<typeof ToolFailureSchema>;

/** A plan window's use over a trial, as the provider reported it on the trial's calls: `from` on the first, `to` on
 *  the last, in percent. An account's window is shared by every trial on it, so a delta is an upper bound. */
const PlanUsageSchema = v.object({ account: v.string(), measure: v.string(), from: v.number(), to: v.number() });

/** A tool call the agent waited on: the actor that made it, its tool, what it ran (a shell's command, a program's
 *  opening lines), and how long the agent waited on it (a call moved to the background, until it moved). */
const WaitedCallSchema = v.object({ actor: v.string(), tool: v.string(), ran: v.string(), wallMs: v.number() });

/** Where a trial's agent waited (`measureWaits`). */
const TrialWaitsSchema = v.object({
  /** Each shell command or program that became a job, and what moved it: its foreground window, or a person writing. */
  backgrounded: v.array(v.object({ ...WaitedCallSchema.entries, by: v.picklist(['window', 'person']) })),
  /** The trial's slowest calls, slowest first. */
  slowest: v.array(WaitedCallSchema),
  /** How long its calls held the agent past the 30 s a person-watched turn waits: what the 300 s window of a turn a
   *  wake started costs the trial. */
  pastInteractiveMs: v.number(),
});

export type PlanUsage = v.InferOutput<typeof PlanUsageSchema>;

const CacheSchema = v.object({
  hitShare: v.nullable(v.number()), ema: v.nullable(v.number()), p95: v.nullable(v.number()),
  p99: v.nullable(v.number()), samples: Count,
});

/** One trial as the harness reported it, normalized by vitest-evals (`normalizeHarnessRun`). */
export const HarnessRunSchema = v.looseObject({
  session: v.looseObject({
    metadata: v.looseObject({
      taskId: v.pipe(v.string(), v.minLength(1)),
      taskVersion: v.pipe(v.string(), v.minLength(1)),
      evalCommit: v.pipe(v.string(), v.minLength(1)),
      productSha: v.pipe(v.string(), v.minLength(1)),
      arm: v.pipe(v.string(), v.minLength(1)),
      trial: v.pipe(v.number(), v.integer(), v.minValue(1)),
      /** The workspace the trial ran in, by name: what joins it to the platform's logs. */
      workspace: v.optional(v.nullable(v.string())),
    }),
    events: v.optional(v.array(TranscriptEventSchema), []),
  }),
  usage: v.looseObject({
    model: v.pipe(v.string(), v.minLength(1)),
    inputTokens: v.optional(Count),
    outputTokens: v.optional(Count),
    metadata: v.optional(v.looseObject({
      costUsd: v.optional(v.pipe(v.number(), v.minValue(0))),
      cacheReadTokens: v.optional(Count),
      cacheWriteTokens: v.optional(Count),
      cache: v.optional(CacheSchema),
      steps: v.optional(v.array(StepUsageSchema), []),
      plan: v.optional(v.array(PlanUsageSchema), []),
    }), { steps: [], plan: [] }),
  }),
  output: v.looseObject({
    metrics: v.object({
      modelTurns: Count, toolCalls: Count, toolErrors: Count, badInputCalls: Count, unknownToolCalls: Count, providerWaits: Count,
      providerWaitMs: v.pipe(v.number(), v.minValue(0)),
    }),
    toolFailures: v.optional(v.array(ToolFailureSchema), []),
    waits: v.optional(TrialWaitsSchema, { backgrounded: [], slowest: [], pastInteractiveMs: 0 }),
    turns: v.array(v.looseObject({
      part: v.pipe(v.string(), v.minLength(1)),
      turn: v.pipe(v.number(), v.integer(), v.minValue(1)),
      outcome: v.looseObject({ status: v.picklist(TURN_OUTCOMES), message: v.optional(v.string()), heldBy: v.optional(v.array(v.string())) }),
      checks: v.optional(v.array(CheckSchema), []),
    })),
  }),
  errors: v.array(v.looseObject({ name: v.string(), message: v.string() })),
});

export type HarnessRun = v.InferOutput<typeof HarnessRunSchema>;

export type UsageMetadata = Pick<HarnessRun['usage']['metadata'], 'costUsd' | 'cacheReadTokens' | 'cacheWriteTokens' | 'cache' | 'steps' | 'plan'>;

/** Public run ledgers retain each actor's request identity, including hired agents and swarm nodes. */
export type ActorLedger = { readonly actor: string; readonly events: readonly RunEvent[] };

/** Complete token totals, and Activity's cache distribution over the reported per-request rates. */
export function summarizePromptUsage(steps: readonly StepUsage[]) {
  const total = (field: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'): number | undefined => {
    if (steps.length === 0) return undefined;

    let tokens = 0;

    for (const step of steps) {
      const count = step[field];

      if (count === null) return undefined;
      tokens += count;
    }

    return tokens;
  };

  const inputTokens = total('inputTokens');
  const cacheReadTokens = total('cacheReadTokens');

  const { ema, p95, p99, samples } = summarizeSteps(steps.map((step) => ({ usage: {
    input: step.inputTokens ?? undefined, cacheRead: step.cacheReadTokens ?? undefined,
  } })), { windowLimit: steps.length }).cacheHit;

  return {
    inputTokens, outputTokens: total('outputTokens'), cacheReadTokens, cacheWriteTokens: total('cacheWriteTokens'),
    cache: { hitShare: inputTokens === undefined || inputTokens === 0 || cacheReadTokens === undefined ? null : cacheReadTokens / inputTokens,
      ema, p95, p99, samples },
  };
}

/** Every request of each run but each actor's first, which nothing can be cached for, that reported both counts. */
function steadySteps(runs: readonly (readonly StepUsage[])[]): { readonly prompt: number; readonly cached: number }[] {
  return runs.flatMap((steps) => {
    const started = new Set<string>();

    return steps.flatMap((step) => {
      const first = !started.has(step.actor);

      started.add(step.actor);

      return first || step.inputTokens === null || step.cacheReadTokens === null || step.inputTokens === 0
        ? [] : [{ prompt: step.inputTokens, cached: step.cacheReadTokens }];
    });
  });
}

/** Cache-read over prompt tokens, token-weighted over the steady requests (`steadySteps`); null with none. */
export function steadyCacheShare(runs: readonly (readonly StepUsage[])[]): number | null {
  const steps = steadySteps(runs);
  const prompt = steps.reduce((sum, step) => sum + step.prompt, 0);

  return prompt > 0 ? steps.reduce((sum, step) => sum + step.cached, 0) / prompt : null;
}

/** The fifth percentile of the steady requests' own cache rates, nearest rank as Activity reads one: the share that a
 *  whole request missing drives down, which the token-weighted share hides. Null with no steady request. */
export function steadyCacheP5(runs: readonly (readonly StepUsage[])[]): number | null {
  const rates = steadySteps(runs).map((step) => step.cached / step.prompt).sort((left, right) => left - right);

  return rates.length === 0 ? null : rates[Math.max(1, Math.ceil(0.05 * rates.length)) - 1] ?? null;
}

export type WaitedCall = v.InferOutput<typeof WaitedCallSchema>;

export type TrialWaits = v.InferOutput<typeof TrialWaitsSchema>;

/** The slowest calls a trial keeps. */
const SLOWEST_PER_TRIAL = 5;

/** What a call ran, as a reader scans for it: a shell's command, a program's opening, else its input. */
function ranBy(args: JsonValue | undefined): string {
  const shell = v.safeParse(v.object({ command: v.string() }), args);
  const program = v.safeParse(v.object({ code: v.string() }), args);
  let text = JSON.stringify(args ?? null);

  if (shell.success) text = shell.output.command;
  else if (program.success) text = program.output.code;

  return text.replace(/\s+/gu, ' ').trim().slice(0, 160);
}

/** Where a trial's agent waited, over every actor's ledger: each shell command or program that became a job, and the
 *  trial's slowest calls. A call's wall time is the wait it caused: a backgrounded one's ends where it moved. */
export function measureWaits(ledgers: readonly ActorLedger[]): TrialWaits {
  const calls = ledgers.flatMap(({ actor, events }) => events.flatMap((event) => (event.type === 'tool_call_end' && event.durationMs !== undefined
    ? [{ call: { actor, tool: event.name, ran: ranBy(event.args), wallMs: event.durationMs }, result: event.result }]
    : [])));

  const backgrounded = calls.flatMap(({ call, result }) => {
    // A spawn hands back its job by design; only a shell command or a program waits out a window.
    const handle = v.safeParse(BackgroundHandleSchema, result);

    return handle.success && (call.tool === 'shell' || call.tool === 'eval') ? [{ ...call, by: backgroundedBy(handle.output) }] : [];
  });

  return {
    backgrounded,
    slowest: calls.map(({ call }) => call).sort((a, b) => b.wallMs - a.wallMs).slice(0, SLOWEST_PER_TRIAL),
    pastInteractiveMs: calls.reduce((sum, { call }) => sum + Math.max(0, call.wallMs - BACKGROUND_POLICY.interactive.detachAfterMs), 0),
  };
}

/** Each plan window's use over a trial, from the quota its calls' answers carried (`PlanUsage`). */
export function measurePlanUsage(ledgers: readonly ActorLedger[]): PlanUsage[] {
  const seen = new Map<string, PlanUsage & { readonly firstAt: number; readonly lastAt: number }>();

  for (const { events } of ledgers) {
    for (const event of events) {
      if ((event.type !== 'step_finish' && event.type !== 'model_call') || event.account?.quota === undefined) continue;
      const { provider, name, quota } = event.account;

      for (const window of quota.windows) {
        if (window.usedPercent === undefined) continue;
        const account = `${provider}@${name}`;
        const key = `${account}\u0000${window.measure}`;
        const held = seen.get(key);

        seen.set(key, {
          account, measure: window.measure,
          from: held === undefined || quota.at < held.firstAt ? window.usedPercent : held.from,
          to: held === undefined || quota.at >= held.lastAt ? window.usedPercent : held.to,
          firstAt: Math.min(held?.firstAt ?? quota.at, quota.at), lastAt: Math.max(held?.lastAt ?? quota.at, quota.at),
        });
      }
    }
  }

  return [...seen.values()].map(({ account, measure, from, to }) => ({ account, measure, from, to }));
}

/** Each provider-reported request, oldest first. Missing counts stay unknown, never zero. */
export function measurePromptUsage(ledgers: readonly ActorLedger[]) {
  const steps: StepUsage[] = [];

  for (const { actor, events } of ledgers) {
    for (const event of events) {
      if (event.type !== 'step_finish') continue;

      steps.push({
        actor, timestamp: event.timestamp, runId: event.runId, stepIndex: event.stepIndex,
        inputTokens: event.usage?.input ?? null, outputTokens: event.usage?.output ?? null,
        cacheReadTokens: event.usage?.cacheRead ?? null, cacheWriteTokens: event.usage?.cacheWrite ?? null,
      });
    }
  }

  steps.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.actor.localeCompare(b.actor)
    || a.runId.localeCompare(b.runId) || a.stepIndex - b.stepIndex);

  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cache } = summarizePromptUsage(steps);
  const metadata: UsageMetadata = { steps, cache, plan: [] };

  if (cacheReadTokens !== undefined) metadata.cacheReadTokens = cacheReadTokens;

  if (cacheWriteTokens !== undefined) metadata.cacheWriteTokens = cacheWriteTokens;

  return { inputTokens, outputTokens, metadata };
}

const AssertionSchema = v.looseObject({
  status: v.picklist(['passed', 'failed']),
  duration: v.pipe(v.number(), v.minValue(0)),
  meta: v.looseObject({ harness: v.looseObject({ run: HarnessRunSchema }) }),
});

// One entry per task file. A file that failed before its first trial (a collection error) is still
// listed, with no assertions and the error in `message`.
const FileSchema = v.looseObject({
  name: v.string(),
  message: v.optional(v.string()),
  startTime: v.optional(v.number()),
  endTime: v.optional(v.number()),
  assertionResults: v.array(AssertionSchema),
});

const ResultsSchema = v.looseObject({ testResults: v.array(FileSchema) });

export type Assertion = v.InferOutput<typeof AssertionSchema>;

export type EvalFile = v.InferOutput<typeof FileSchema>;

export type TranscriptEntry = v.InferOutput<typeof TranscriptEventSchema>;

/** A report's trials as far as whether each ran: vitest lists a trial whose suite failed before it as `skipped`. */
const StatusesSchema = v.looseObject({
  testResults: v.array(v.looseObject({ name: v.string(), assertionResults: v.array(v.looseObject({ status: v.string() })) })),
});

/** Parse one report; `side` names it in errors. A task whose trials did not run is named before anything else. */
export function parseResults(side: string, text: string): EvalFile[] {
  const json: unknown = JSON.parse(text);
  const statuses = v.safeParse(StatusesSchema, json);

  for (const file of statuses.success ? statuses.output.testResults : []) {
    const unrun = file.assertionResults.filter((trial) => trial.status !== 'passed' && trial.status !== 'failed');

    if (unrun.length > 0) {
      const how = [...new Set(unrun.map((trial) => trial.status))].join(', ');

      throw new Error(`${basename(file.name)}: ${String(unrun.length)} of its trials did not run (${how})`);
    }
  }

  const parsed = v.safeParse(ResultsSchema, json);

  if (!parsed.success) {
    throw new Error(`${side} results are invalid: ${v.summarize(parsed.issues)}`, { cause: new v.ValiError(parsed.issues) });
  }

  if (trials(parsed.output.testResults).length === 0) throw new Error(`${side} results contain no trials`);

  return parsed.output.testResults;
}

/** Every trial in the report, in file order. */
export function trials(files: readonly EvalFile[]): Assertion[] {
  return files.flatMap((file) => file.assertionResults);
}
