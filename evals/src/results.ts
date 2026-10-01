// The vitest JSON report `bun run evals` writes, as far as the comparison and the trajectory
// renderer read it. Every object is loose: the reporter adds fields freely and only these are relied on.
import { basename } from 'node:path';
import * as v from 'valibot';
import { JsonValueSchema } from '@kinu.run/core';
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
  runId: v.string(),
  stepIndex: Count,
  inputTokens: v.nullable(Count),
  cacheReadTokens: v.nullable(Count),
  cacheWriteTokens: v.nullable(Count),
});

export type StepUsage = v.InferOutput<typeof StepUsageSchema>;

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
    }),
    events: v.optional(v.array(TranscriptEventSchema), []),
  }),
  usage: v.looseObject({
    model: v.pipe(v.string(), v.minLength(1)),
    inputTokens: v.optional(Count),
    outputTokens: v.optional(Count, 0),
    metadata: v.optional(v.looseObject({
      costUsd: v.optional(v.pipe(v.number(), v.minValue(0))),
      cacheReadTokens: v.optional(Count),
      cacheWriteTokens: v.optional(Count),
      steps: v.optional(v.array(StepUsageSchema), []),
    }), { steps: [] }),
  }),
  output: v.looseObject({
    metrics: v.object({ modelTurns: Count, toolCalls: Count, toolErrors: Count, providerWaits: Count, providerWaitMs: v.pipe(v.number(), v.minValue(0)) }),
    turns: v.array(v.looseObject({
      outcome: v.looseObject({ status: v.picklist(TURN_OUTCOMES), message: v.optional(v.string()) }),
      checks: v.optional(v.array(CheckSchema), []),
    })),
  }),
  errors: v.array(v.looseObject({ name: v.string(), message: v.string() })),
});

export type HarnessRun = v.InferOutput<typeof HarnessRunSchema>;

export type UsageMetadata = Pick<HarnessRun['usage']['metadata'], 'costUsd' | 'cacheReadTokens' | 'cacheWriteTokens' | 'steps'>;

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
