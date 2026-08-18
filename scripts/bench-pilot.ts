import { readFileSync } from 'node:fs';
import * as v from 'valibot';
import { fnv1a64, parseJsonValue } from '../packages/core/src/index';
import type { AttemptBudget, AttemptOutcome, JsonValue, LLMProviderConfig } from '../packages/core/src/index';

export const MIN_PILOT_TASKS = 40;
export const MIN_PILOT_REPEATS = 3;

const NonNegativeIntegerSchema = v.pipe(v.number(), v.finite(), v.integer(), v.minValue(0));
const PositiveIntegerSchema = v.pipe(NonNegativeIntegerSchema, v.minValue(1));
const NonNegativeNumberSchema = v.pipe(v.number(), v.finite(), v.minValue(0));
const AttemptBudgetSchema = v.strictObject({
  wallClockMs: PositiveIntegerSchema,
  maxTokens: PositiveIntegerSchema,
});
/** One task's repeats. `tokens` and `modelCalls` are required and complete: a
 *  stability pilot exists to say what a live variant costs run to run, so an
 *  attempt with no measurement is not a cheap data point, it is a hole in the
 *  measurement — `buildPilotReport` throws on one rather than writing a zero. */
const PilotTaskResultSchema = v.strictObject({
  taskId: v.pipe(v.string(), v.minLength(1)),
  attempts: PositiveIntegerSchema,
  repeatIndices: v.array(NonNegativeIntegerSchema),
  passes: NonNegativeIntegerSchema,
  tokens: v.array(NonNegativeIntegerSchema),
  modelCalls: v.array(NonNegativeIntegerSchema),
  errors: NonNegativeIntegerSchema,
  budgetBreaches: NonNegativeIntegerSchema,
});

export const PilotReportSchema = v.strictObject({
  schemaVersion: v.literal(2),
  kind: v.literal('bench-stability-pilot'),
  family: v.picklist(['defect', 'longhorizon']),
  manifestHash: v.pipe(v.string(), v.minLength(1)),
  variant: v.pipe(v.string(), v.minLength(1)),
  model: v.pipe(v.string(), v.minLength(1)),
  providerHash: v.pipe(v.string(), v.minLength(1)),
  budget: AttemptBudgetSchema,
  seed: v.pipe(v.number(), v.finite()),
  tasks: PositiveIntegerSchema,
  taskIds: v.array(v.pipe(v.string(), v.minLength(1))),
  taskResults: v.array(PilotTaskResultSchema),
  repeats: PositiveIntegerSchema,
  attempts: PositiveIntegerSchema,
  passed: NonNegativeIntegerSchema,
  unstableTaskIds: v.array(v.pipe(v.string(), v.minLength(1))),
  errors: NonNegativeIntegerSchema,
  budgetBreaches: NonNegativeIntegerSchema,
  /** Null only for an empty sample: the mean and the maximum of no attempts do
   *  not exist, and reporting them as 0 puts a measured-looking cost on a run
   *  that measured nothing. A total over no attempts really is 0. */
  meanTokens: v.nullable(NonNegativeNumberSchema),
  maxObservedTokens: v.nullable(NonNegativeIntegerSchema),
  totalModelCalls: NonNegativeIntegerSchema,
  meanModelCalls: v.nullable(NonNegativeNumberSchema),
  maxObservedModelCalls: v.nullable(NonNegativeIntegerSchema),
});

export type PilotReport = v.InferOutput<typeof PilotReportSchema>;

export interface ExpectedPilot {
  family: 'defect' | 'longhorizon';
  manifestHash: string;
  model: string;
  providerHash: string;
  budget: AttemptBudget;
  comparedVariants: readonly string[];
}

function parsePilotReport(input: JsonValue): PilotReport {
  const parsed = v.safeParse(PilotReportSchema, input);
  if (!parsed.success) {
    throw new Error(`invalid stability pilot report: ${parsed.issues.map((issue) => issue.message).join('; ')}`);
  }
  return parsed.output;
}

export function validatePilotReport(input: JsonValue, expected: ExpectedPilot): PilotReport {
  const report = parsePilotReport(input);
  if (report.tasks < MIN_PILOT_TASKS) {
    throw new Error(`stability pilot needs at least ${MIN_PILOT_TASKS} distinct tasks; got ${report.tasks}`);
  }
  if (report.repeats < MIN_PILOT_REPEATS) {
    throw new Error(`stability pilot needs at least ${MIN_PILOT_REPEATS} repeats; got ${report.repeats}`);
  }
  const distinctTaskIds = new Set(report.taskIds);
  if (report.taskIds.length !== report.tasks || distinctTaskIds.size !== report.tasks) {
    throw new Error('stability pilot taskIds must contain each distinct task exactly once');
  }
  if (report.attempts !== report.tasks * report.repeats) {
    throw new Error('stability pilot attempt count does not equal tasks × repeats');
  }
  if (report.taskResults.length !== report.tasks) {
    throw new Error('stability pilot must include one task result per task');
  }
  const resultIds = new Set(report.taskResults.map((result) => result.taskId));
  if (resultIds.size !== report.tasks || report.taskIds.some((taskId) => !resultIds.has(taskId))) {
    throw new Error('stability pilot task results do not match taskIds');
  }
  for (const result of report.taskResults) {
    if (
      result.attempts !== report.repeats
      || result.tokens.length !== report.repeats
      || result.modelCalls.length !== report.repeats
      || result.repeatIndices.length !== report.repeats
    ) {
      throw new Error(`stability pilot task ${result.taskId} did not complete every repeat`);
    }
    const expectedRepeats = Array.from({ length: report.repeats }, (_, repeat) => repeat);
    if (JSON.stringify([...result.repeatIndices].sort((a, b) => a - b)) !== JSON.stringify(expectedRepeats)) {
      throw new Error(`stability pilot task ${result.taskId} has missing or duplicate repeat indices`);
    }
    if (result.passes > result.attempts) {
      throw new Error(`stability pilot task ${result.taskId} has more passes than attempts`);
    }
    if (result.errors > result.attempts || result.budgetBreaches > result.attempts) {
      throw new Error(`stability pilot task ${result.taskId} has impossible error or breach counts`);
    }
  }
  const taskPasses = report.taskResults.reduce((sum, result) => sum + result.passes, 0);
  const taskErrors = report.taskResults.reduce((sum, result) => sum + result.errors, 0);
  const taskBreaches = report.taskResults.reduce((sum, result) => sum + result.budgetBreaches, 0);
  if (taskPasses !== report.passed || taskErrors !== report.errors || taskBreaches !== report.budgetBreaches) {
    throw new Error('stability pilot aggregate counts do not match its task results');
  }
  const unstable = report.taskResults
    .filter((result) => result.passes > 0 && result.passes < result.attempts)
    .map((result) => result.taskId)
    .sort();
  if (JSON.stringify([...report.unstableTaskIds].sort()) !== JSON.stringify(unstable)) {
    throw new Error('stability pilot unstable task list does not match its task results');
  }
  // Re-derived, not trusted. The producer and this validator have to agree about
  // the empty sample too: a mean or a maximum over no attempts is absent, so a
  // report claiming 0 there disagrees with its own task results and is rejected.
  const reportedTokens = report.taskResults.flatMap((result) => result.tokens);
  const meanTokens = reportedTokens.length === 0
    ? null
    : reportedTokens.reduce((sum, tokens) => sum + tokens, 0) / reportedTokens.length;
  const maxObservedTokens = reportedTokens.length === 0 ? null : Math.max(...reportedTokens);
  if (report.meanTokens !== meanTokens || report.maxObservedTokens !== maxObservedTokens) {
    throw new Error('stability pilot token aggregates do not match its task results');
  }
  const reportedCalls = report.taskResults.flatMap((result) => result.modelCalls);
  const totalModelCalls = reportedCalls.reduce((sum, calls) => sum + calls, 0);
  const meanModelCalls = reportedCalls.length === 0 ? null : totalModelCalls / reportedCalls.length;
  const maxObservedModelCalls = reportedCalls.length === 0 ? null : Math.max(...reportedCalls);
  if (
    report.totalModelCalls !== totalModelCalls
    || report.meanModelCalls !== meanModelCalls
    || report.maxObservedModelCalls !== maxObservedModelCalls
  ) {
    throw new Error('stability pilot model-call aggregates do not match its task results');
  }
  if (report.passed > report.attempts) throw new Error('stability pilot passed count exceeds its attempts');
  if (report.family !== expected.family || report.manifestHash !== expected.manifestHash) {
    throw new Error('stability pilot used a different corpus or manifest');
  }
  if (report.model !== expected.model || report.providerHash !== expected.providerHash) {
    throw new Error('stability pilot used a different model or provider endpoint');
  }
  if (
    report.budget.wallClockMs !== expected.budget.wallClockMs
    || report.budget.maxTokens !== expected.budget.maxTokens
  ) {
    throw new Error('stability pilot used a different compute envelope');
  }
  if (!expected.comparedVariants.includes(report.variant)) {
    throw new Error('stability pilot variant must be one of the compared arms');
  }
  if (report.errors > 0) throw new Error(`stability pilot contains ${report.errors} worker error(s)`);
  if (report.budgetBreaches > 0) {
    throw new Error(`stability pilot contains ${report.budgetBreaches} budget breach(es)`);
  }
  return report;
}

export function loadAndValidatePilotReport(path: string, expected: ExpectedPilot): PilotReport {
  let decoded: JsonValue;
  try {
    decoded = parseJsonValue(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read stability pilot report ${path}`, { cause: error });
  }
  return validatePilotReport(decoded, expected);
}

export function benchProviderHash(llm: LLMProviderConfig): string {
  return fnv1a64(JSON.stringify([llm.name, llm.baseURL, llm.model]));
}

export function buildPilotReport(input: {
  family: 'defect' | 'longhorizon';
  manifestHash: string;
  variant: string;
  llm: LLMProviderConfig;
  budget: AttemptBudget;
  seed: number;
  repeats: number;
  outcomes: readonly AttemptOutcome[];
}): PilotReport {
  const taskIds = [...new Set(input.outcomes.map((outcome) => outcome.taskId))].sort();
  const byTask = new Map<string, AttemptOutcome[]>();
  for (const outcome of input.outcomes) {
    const outcomes = byTask.get(outcome.taskId) ?? [];
    outcomes.push(outcome);
    byTask.set(outcome.taskId, outcomes);
  }
  const unstableTaskIds = taskIds.filter((taskId) => {
    const outcomes = byTask.get(taskId) ?? [];
    const passes = outcomes.filter((outcome) => outcome.passed).length;
    return passes > 0 && passes < outcomes.length;
  });
  const taskResults = taskIds.map((taskId) => {
    const outcomes = byTask.get(taskId) ?? [];
    return {
      taskId,
      attempts: outcomes.length,
      repeatIndices: outcomes.map((outcome) => outcome.repeat),
      passes: outcomes.filter((outcome) => outcome.passed).length,
      tokens: outcomes.map((outcome) => {
        if (outcome.tokens === undefined) {
          throw new Error(`stability pilot task ${taskId} has no token measurement for repeat ${outcome.repeat}`);
        }
        return outcome.tokens;
      }),
      modelCalls: outcomes.map((outcome) => {
        if (outcome.modelCalls === undefined) {
          throw new Error(`stability pilot task ${taskId} has no model-call evidence for repeat ${outcome.repeat}`);
        }
        return outcome.modelCalls;
      }),
      errors: outcomes.filter((outcome) => outcome.error !== undefined).length,
      budgetBreaches: outcomes.filter((outcome) => outcome.budgetBreach !== null).length,
    };
  });
  const tokens = input.outcomes.map((outcome) => {
    if (outcome.tokens === undefined) {
      throw new Error(`stability pilot attempt ${outcome.taskId} repeat ${outcome.repeat} has no token measurement`);
    }
    return outcome.tokens;
  });
  const modelCalls = input.outcomes.map((outcome) => {
    if (outcome.modelCalls === undefined) {
      throw new Error(`stability pilot attempt ${outcome.taskId} repeat ${outcome.repeat} has no model-call evidence`);
    }
    return outcome.modelCalls;
  });
  return parsePilotReport({
    schemaVersion: 2,
    kind: 'bench-stability-pilot',
    family: input.family,
    manifestHash: input.manifestHash,
    variant: input.variant,
    model: input.llm.model,
    providerHash: benchProviderHash(input.llm),
    budget: {
      wallClockMs: input.budget.wallClockMs,
      maxTokens: input.budget.maxTokens,
    },
    seed: input.seed,
    tasks: taskIds.length,
    taskIds,
    taskResults,
    repeats: input.repeats,
    attempts: input.outcomes.length,
    passed: input.outcomes.filter((outcome) => outcome.passed).length,
    unstableTaskIds,
    errors: input.outcomes.filter((outcome) => outcome.error !== undefined).length,
    budgetBreaches: input.outcomes.filter((outcome) => outcome.budgetBreach !== null).length,
    meanTokens: tokens.length === 0 ? null : tokens.reduce((sum, value) => sum + value, 0) / tokens.length,
    maxObservedTokens: tokens.length === 0 ? null : Math.max(...tokens),
    totalModelCalls: modelCalls.reduce((sum, value) => sum + value, 0),
    meanModelCalls: modelCalls.length === 0
      ? null
      : modelCalls.reduce((sum, value) => sum + value, 0) / modelCalls.length,
    maxObservedModelCalls: modelCalls.length === 0 ? null : Math.max(...modelCalls),
  });
}
