import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  decodeJsonValue, parseJsonValue, validateWithRetries,
  type AttemptOutcome, type BenchTask, type JsonValue, type SealedSplit, type TaskValidation,
} from '../packages/core/src/index.js';

export const VALIDATION_DIAGNOSTICS_FILE = 'validation-diagnostics.json';

const NonNegativeIntegerSchema = v.pipe(v.number(), v.finite(), v.integer(), v.minValue(0));
const PositiveIntegerSchema = v.pipe(NonNegativeIntegerSchema, v.minValue(1));

const CheckOutcomeSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  passed: v.boolean(),
  exitCode: v.nullable(NonNegativeIntegerSchema),
  durationMs: NonNegativeIntegerSchema,
  output: v.string(),
});

const AttemptOutcomeSchema = v.strictObject({
  taskId: v.pipe(v.string(), v.minLength(1)),
  variantId: v.pipe(v.string(), v.minLength(1)),
  slot: v.picklist(['a', 'b']),
  repeat: NonNegativeIntegerSchema,
  passed: v.boolean(),
  checks: v.array(CheckOutcomeSchema),
  durationMs: NonNegativeIntegerSchema,
  tokens: NonNegativeIntegerSchema,
  modelCalls: v.optional(NonNegativeIntegerSchema),
  peakPromptTokens: NonNegativeIntegerSchema,
  budgetBreach: v.nullable(v.picklist(['wall-clock', 'tokens'])),
  error: v.optional(v.string()),
});

const ValidationDiagnosticAttemptSchema = v.pipe(
  v.strictObject({
    taskId: v.pipe(v.string(), v.minLength(1)),
    split: v.picklist(['dev', 'sealed']),
    attempt: PositiveIntegerSchema,
    broken: AttemptOutcomeSchema,
    oracle: AttemptOutcomeSchema,
  }),
  v.check((entry) => (
    entry.broken.taskId === entry.taskId
      && entry.oracle.taskId === entry.taskId
      && entry.broken.slot === 'a'
      && entry.oracle.slot === 'b'
      && entry.broken.repeat === entry.attempt - 1
      && entry.oracle.repeat === entry.attempt - 1
  ), 'validation diagnostic attempt identity does not match its outcomes'),
);

export const ValidationDiagnosticsSchema = v.strictObject({
  schemaVersion: v.literal(1),
  kind: v.literal('bench-validation-diagnostics'),
  family: v.picklist(['defect', 'longhorizon']),
  corpusPath: v.pipe(v.string(), v.minLength(1)),
  manifestHash: v.pipe(v.string(), v.minLength(1)),
  validateRetries: NonNegativeIntegerSchema,
  attempts: v.array(ValidationDiagnosticAttemptSchema),
});

export type ValidationDiagnostics = v.InferOutput<typeof ValidationDiagnosticsSchema>;
export type ValidationSplit = v.InferOutput<typeof ValidationDiagnosticAttemptSchema>['split'];

function validationDiagnostics(input: JsonValue): ValidationDiagnostics {
  const parsed = v.safeParse(ValidationDiagnosticsSchema, input);
  if (!parsed.success) {
    throw new Error(`invalid validation diagnostics: ${parsed.issues.map((issue) => issue.message).join('; ')}`);
  }
  return parsed.output;
}

export function loadValidationDiagnostics(path: string): ValidationDiagnostics {
  return validationDiagnostics(parseJsonValue(readFileSync(path, 'utf8')));
}

interface ValidationDiagnosticAttemptInput {
  taskId: string;
  split: ValidationSplit;
  attempt: number;
  broken: AttemptOutcome;
  oracle: AttemptOutcome;
}

interface ValidationDiagnosticsRecorder {
  record(input: ValidationDiagnosticAttemptInput): void;
}

function createValidationDiagnosticsRecorder(options: {
  runRoot: string;
  family: 'defect' | 'longhorizon';
  corpusPath: string;
  manifestHash: string;
  validateRetries: number;
}): ValidationDiagnosticsRecorder {
  const path = join(options.runRoot, VALIDATION_DIAGNOSTICS_FILE);
  let document = validationDiagnostics(decodeJsonValue({ value: {
    schemaVersion: 1,
    kind: 'bench-validation-diagnostics',
    family: options.family,
    corpusPath: options.corpusPath,
    manifestHash: options.manifestHash,
    validateRetries: options.validateRetries,
    attempts: [],
  } }));

  const persist = (): void => {
    const temp = `${path}.${process.pid}.${document.attempts.length}.tmp`;
    writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
  };
  persist();

  return {
    record: (input) => {
      document = validationDiagnostics(decodeJsonValue({
        value: { ...document, attempts: [...document.attempts, input] },
      }));
      persist();
    },
  };
}

export interface WellFormedAttempt {
  broken: AttemptOutcome;
  oracle: AttemptOutcome;
}

export interface RunValidationOptions {
  family: 'defect' | 'longhorizon';
  corpusPath: string;
  manifestHash: string;
  validateRetries: number;
  runRoot: string;
  devTasks: readonly BenchTask[];
  sealed: SealedSplit;
  runAttempt: (task: BenchTask, repeat: number) => Promise<WellFormedAttempt>;
  log?: (line: string) => void;
}

function attemptResult(pair: WellFormedAttempt) {
  const ok = !pair.broken.passed && pair.oracle.passed;
  const failing = pair.broken.checks.find((check) => !check.passed)?.id ?? 'none';
  return {
    ok,
    detail: ok
      ? `unsolved trips ${failing}, oracle restores it`
      : `unsolved→${pair.broken.passed ? 'PASS (nothing to solve)' : 'fail'}, oracle→${pair.oracle.passed ? 'pass' : `FAIL${pair.oracle.error ? ` ${pair.oracle.error}` : ''}`}`,
  };
}

export async function runValidation(options: RunValidationOptions): Promise<number> {
  const log = options.log ?? console.log;
  const diagnostics = createValidationDiagnosticsRecorder(options);
  const validate = (task: BenchTask, split: ValidationSplit): Promise<TaskValidation> =>
    validateWithRetries(options.validateRetries, async (attempt) => {
      const pair = await options.runAttempt(task, attempt - 1);
      diagnostics.record({ taskId: task.id, split, attempt, ...pair });
      return attemptResult(pair);
    });

  log(`Validating ${options.corpusPath}`);
  log('Each task must FAIL with nothing done and PASS under the oracle.');
  log(`A failing task is re-checked up to ${options.validateRetries} more time(s) before it is called BAD.\n`);

  let bad = 0;
  const flakyDev: string[] = [];
  log(`dev split (${options.devTasks.length} tasks):`);
  for (const task of options.devTasks) {
    const result = await validate(task, 'dev');
    const onlyOnRetry = result.ok && (result.passedOnAttempt ?? 1) > 1;
    if (!result.ok) bad++;
    else if (onlyOnRetry) flakyDev.push(task.id);
    log(`  ${!result.ok ? 'BAD ' : onlyOnRetry ? 'FLKY' : 'ok  '} ${task.id.padEnd(28)} ${result.detail}`);
  }

  const sealedResult = await options.sealed.validate((task) => validate(task, 'sealed'));
  bad += sealedResult.invalid.length;
  log(`\nsealed split (${sealedResult.checked} tasks): ${sealedResult.checked - sealedResult.invalid.length} valid`);
  for (const id of sealedResult.invalid) log(`  BAD  ${id}`);
  for (const id of sealedResult.flaky) log(`  FLKY ${id}`);

  const total = options.devTasks.length + sealedResult.checked;
  const flaky = flakyDev.length + sealedResult.flaky.length;
  log(`\n${total - bad}/${total} tasks valid.`);
  if (flaky > 0) {
    log(`${flaky} task(s) only passed on a retry — non-deterministic, and a single scored attempt on them can record a false fail:`);
    for (const id of [...flakyDev, ...sealedResult.flaky]) log(`  ${id}`);
    log('Run compare with --repeats > 1 so these show up as unstable rather than as a score.');
  }
  if (bad > 0) log('A task that passes with nothing done, or that the oracle cannot pass, is not a task.');
  return bad === 0 ? 0 : 1;
}
