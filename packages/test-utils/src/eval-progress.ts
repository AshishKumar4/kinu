/**
 * Durable per-case progress so a restarted eval run resumes instead of repaying finished episodes.
 * Phases: `planned` (owed), `started` (in flight; marked `incomplete` on restart), `progress` (finished,
 * output adoptable), `settled` (recorded downstream), `incomplete` (never scored).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { JsonValueSchema, type JsonValue } from '@kinu.run/core';

const FILE_NAME = 'eval-progress.json';

const SCHEMA = 1;

export const CasePhaseSchema = v.picklist([
  'planned', 'started', 'progress', 'settled', 'incomplete',
]);

export type CasePhase = v.InferOutput<typeof CasePhaseSchema>;

/** How a case that ran ended, in the run record's vocabulary. Cancellation is a phase, not an outcome. */
export const CaseOutcomeSchema = v.picklist(['scored', 'inert', 'errored']);

export type CaseOutcome = v.InferOutput<typeof CaseOutcomeSchema>;

/** What one case has done so far, written during the episode so an interrupted case keeps it. */
export interface CaseActivity {
  turns: number;
  toolCalls: number;
  modelSteps: number;
}

/** What one case has produced. `output` is stored verbatim at `progress` so a restart can adopt it. */
export interface CaseRecord {
  taskId: string;
  repetition: number;
  phase: CasePhase;
  updatedAt: string;
  reason?: string;
  outcome?: CaseOutcome;
  activity?: CaseActivity;
  output?: JsonValue;
}

interface ProgressFileV1 {
  schema: 1;
  /** The run identity this state belongs to; a mismatch must not be resumed into. */
  signature: string;
  cases: Record<string, CaseRecord>;
}

const CaseActivitySchema: v.GenericSchema<CaseActivity> = v.object({
  turns: v.number(),
  toolCalls: v.number(),
  modelSteps: v.number(),
});

const CaseRecordSchema: v.GenericSchema<CaseRecord> = v.object({
  taskId: v.string(),
  repetition: v.number(),
  phase: CasePhaseSchema,
  updatedAt: v.string(),
  reason: v.optional(v.string()),
  outcome: v.optional(CaseOutcomeSchema),
  activity: v.optional(CaseActivitySchema),
  output: v.optional(JsonValueSchema),
});

const ProgressFileV1Schema: v.GenericSchema<ProgressFileV1> = v.object({
  schema: v.literal(SCHEMA),
  signature: v.string(),
  cases: v.record(v.string(), CaseRecordSchema),
});

/** The pairing key, same shape as `observationKey` in eval-run.ts without importing it. */
export function caseKey(taskId: string, repetition: number): string {
  return `${taskId}#${String(repetition)}`;
}

function readProgressFile(path: string): ProgressFileV1 | null {
  const parsed = v.safeParse(ProgressFileV1Schema, JSON.parse(readFileSync(path, 'utf8')));

  return parsed.success ? parsed.output : null;
}

/** Open (or create) the progress store in `dir`, adopting existing state only when its {@link signature} matches. */
export function openEvalProgress(dir: string, signature: string): EvalProgressStore {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, FILE_NAME);
  let cases: Record<string, CaseRecord> = {};

  if (existsSync(path)) {
    const parsed = readProgressFile(path);

    if (parsed?.signature === signature) cases = parsed.cases;
    // A mismatched or unreadable file starts fresh; this run could not have used it.
  }

  return new EvalProgressStore(path, signature, cases);
}

/** Find the newest unfinished run directory of this exact shape; completed runs stay immutable. Signature and
 *  expected keys are both checked. */
export function findResumableEvalDir(
  root: string,
  prefix: string,
  signature: string,
  expectedKeys: ReadonlySet<string>,
): string | null {
  if (!existsSync(root)) return null;

  const candidates = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const name of candidates) {
    const dir = join(root, name);
    const path = join(dir, FILE_NAME);

    if (!existsSync(path)) continue;
    const parsed = readProgressFile(path);

    if (parsed?.signature !== signature) continue;

    const complete = [...expectedKeys]
      .every((key) => parsed.cases[key]?.phase === 'settled');

    if (!complete) return dir;
  }

  return null;
}

export interface EvalProgressCase {
  readonly taskId: string;
  readonly repetition: number;
}

export interface AdoptableEvalCase<T extends EvalProgressCase> {
  readonly input: T;
  readonly output: JsonValue;
}

export interface EvalProgressPlan<T extends EvalProgressCase> {
  readonly todo: T[];
  readonly adopt: Array<AdoptableEvalCase<T>>;
}

/** The five states a declared case can be in; exhaustive, so counts sum to what the run owed. */
export type CaseState = 'scored' | 'inert' | 'errored' | 'incomplete' | 'notRun';

export interface EvalCaseCensus<T extends EvalProgressCase = EvalProgressCase> {
  readonly total: number;
  /** Every case reached a verdict; checked before treating a run as finished. */
  readonly complete: boolean;
  readonly states: Readonly<Record<CaseState, readonly T[]>>;
}

/** Which of the five states a stored record is in. `started` counts as `incomplete`. */
function stateOf(record: CaseRecord | undefined): CaseState {
  switch (record?.phase) {
    case undefined:
    case 'planned':
      return 'notRun';
    case 'started':
    case 'incomplete':
      return 'incomplete';
    case 'progress':
    case 'settled':
      // A completed record that lost its outcome is broken: `errored` claims neither score nor cancellation.
      return record.outcome ?? 'errored';
  }
}

export function formatCaseCensus(census: EvalCaseCensus): string {
  const { states } = census;

  const lines = [
    `cases ${String(census.total)} declared — `
    + `${String(states.scored.length)} scored, `
    + `${String(states.inert.length)} inert, `
    + `${String(states.errored.length)} errored, `
    + `${String(states.incomplete.length)} incomplete (operator-cancelled or interrupted), `
    + `${String(states.notRun.length)} not-run`,
  ];

  if (!census.complete) {
    lines.push('  INCOMPLETE RUN — this is not a green result.');

    if (states.incomplete.length > 0) {
      lines.push('    never settled:    '
        + states.incomplete.map((c) => caseKey(c.taskId, c.repetition)).join(', '));
    }

    if (states.notRun.length > 0) {
      lines.push('    never attempted:  '
        + states.notRun.map((c) => caseKey(c.taskId, c.repetition)).join(', '));
    }
  }

  return lines.join('\n');
}

export class EvalProgressStore {
  private dirty = false;

  constructor(
    private readonly path: string,
    readonly signature: string,
    private readonly cases: Record<string, CaseRecord>,
  ) {}

  record(key: string): CaseRecord | undefined {
    return this.cases[key];
  }

  all(): Readonly<Record<string, CaseRecord>> {
    return this.cases;
  }

  adoptable(): Array<{ key: string; record: CaseRecord }> {
    return Object.entries(this.cases)
      .filter(([, r]) => r.phase === 'progress')
      .map(([key, record]) => ({ key, record }));
  }

  settledKeys(): ReadonlySet<string> {
    return new Set(
      Object.entries(this.cases).filter(([, r]) => r.phase === 'settled').map(([k]) => k),
    );
  }

  /**
   * Record the whole corpus as `planned` before any work begins, so unreached cases are rows the census
   * can count. Existing records are untouched: this is the resume path's first write, not a reset.
   */
  markPlanned(cases: readonly EvalProgressCase[]): void {
    const updatedAt = new Date().toISOString();

    for (const input of cases) {
      const key = caseKey(input.taskId, input.repetition);

      if (this.cases[key]) continue;
      this.cases[key] = {
        taskId: input.taskId, repetition: input.repetition, phase: 'planned', updatedAt,
      };
      this.dirty = true;
    }

    this.flush();
  }

  /** The episode is in flight. Any tally from an earlier attempt is dropped: the case re-runs from the start. */
  markStarted(key: string): void {
    this.set(key, { taskId: taskIdOf(key), repetition: repetitionOf(key), phase: 'started' });
  }

  /** Add one of the episode's own events to the case's tally, durably, so a crashed case still reports progress. */
  markActivity(key: string, delta: Partial<CaseActivity>): void {
    const existing = this.cases[key];
    const base = existing?.activity ?? { turns: 0, toolCalls: 0, modelSteps: 0 };

    const activity: CaseActivity = {
      turns: base.turns + (delta.turns ?? 0),
      toolCalls: base.toolCalls + (delta.toolCalls ?? 0),
      modelSteps: base.modelSteps + (delta.modelSteps ?? 0),
    };

    const updatedAt = new Date().toISOString();
    this.cases[key] = existing
      ? { ...existing, activity, updatedAt }
      : {
        taskId: taskIdOf(key), repetition: repetitionOf(key),
        phase: 'started', activity, updatedAt,
      };
    this.dirty = true;
    this.flush();
  }

  /** The episode finished; store its output and outcome immediately so a restart adopts rather than repeats. */
  markProgress(key: string, output: JsonValue, outcome: CaseOutcome): void {
    const record: Omit<CaseRecord, 'updatedAt'> = {
      taskId: taskIdOf(key), repetition: repetitionOf(key),
      phase: 'progress', outcome, output,
    };

    const activity = this.cases[key]?.activity;

    if (activity) record.activity = activity;
    this.set(key, record);
  }

  markSettled(key: string): void {
    const existing = this.cases[key];

    // Keep output, outcome and tally on settle: the store may be the only surviving copy, and the census reads them.
    const record: Omit<CaseRecord, 'updatedAt'> = {
      taskId: taskIdOf(key),
      repetition: repetitionOf(key),
      phase: 'settled',
    };

    if (existing?.phase === 'progress' && existing.output !== undefined) {
      record.output = existing.output;
    }

    if (existing?.outcome !== undefined) record.outcome = existing.outcome;

    if (existing?.activity !== undefined) record.activity = existing.activity;
    this.set(key, record);
  }

  /** Record that a case began and never settled. Never carries an outcome; keeps the tally. */
  markIncomplete(key: string, reason: string): void {
    const record: Omit<CaseRecord, 'updatedAt'> = {
      taskId: taskIdOf(key), repetition: repetitionOf(key),
      phase: 'incomplete', reason,
    };

    const activity = this.cases[key]?.activity;

    if (activity) record.activity = activity;
    this.set(key, record);
  }

  /** Mark every `started` case incomplete (cancellation). `progress` records stay: their episodes finished. */
  markInFlightIncomplete(reason: string): string[] {
    const marked: string[] = [];

    for (const [key, record] of Object.entries(this.cases)) {
      if (record.phase === 'started') {
        this.markIncomplete(key, reason);
        marked.push(key);
      }
    }

    return marked;
  }

  plan<T extends EvalProgressCase>(cases: readonly T[]): EvalProgressPlan<T> {
    const todo: T[] = [];
    const adopt: Array<AdoptableEvalCase<T>> = [];

    for (const input of cases) {
      const record = this.cases[caseKey(input.taskId, input.repetition)];

      if (record?.phase === 'settled') continue;

      if (record?.phase === 'progress' && record.output !== undefined) {
        adopt.push({ input, output: record.output });
        continue;
      }

      todo.push(input);
    }

    return { todo, adopt };
  }

  /** Every declared case partitioned by state; the corpus, not the observation list, is the denominator. */
  census<T extends EvalProgressCase>(cases: readonly T[]): EvalCaseCensus<T> {
    const states = {
      scored: new Array<T>(),
      inert: new Array<T>(),
      errored: new Array<T>(),
      incomplete: new Array<T>(),
      notRun: new Array<T>(),
    };

    for (const input of cases) {
      states[stateOf(this.cases[caseKey(input.taskId, input.repetition)])].push(input);
    }

    return {
      total: cases.length,
      complete: states.incomplete.length === 0 && states.notRun.length === 0,
      states,
    };
  }

  flush(): void {
    if (!this.dirty) return;

    const payload: ProgressFileV1 = {
      schema: SCHEMA, signature: this.signature, cases: this.cases,
    };

    // Temp + rename: a crash mid-write leaves the previous complete state.
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    renameSync(tmp, this.path);
    this.dirty = false;
  }

  private set(key: string, record: Omit<CaseRecord, 'updatedAt'>): void {
    this.cases[key] = { ...record, updatedAt: new Date().toISOString() };
    this.dirty = true;
    this.flush();
  }
}

function taskIdOf(key: string): string {
  const cut = key.lastIndexOf('#');

  return cut === -1 ? key : key.slice(0, cut);
}

function repetitionOf(key: string): number {
  const cut = key.lastIndexOf('#');

  return cut === -1 ? 0 : Number(key.slice(cut + 1));
}
