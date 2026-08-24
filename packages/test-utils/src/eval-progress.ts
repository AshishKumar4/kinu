/**
 * Durable per-case progress for an eval run that spans hours.
 *
 * A behaviour tier is a long queue of paid episodes. Anything that ends the
 * process early — the operator cancelling, a crash, the machine rebooting — used
 * to throw away every finished episode with it, and re-running the tier repeated
 * work that had already been paid for. This module is the fix: each case moves
 * through `started -> progress -> settled` ON DISK, written at the moment it
 * changes, so a restarted suite resumes instead of repeating.
 *
 * The phases, and what a restart does with each:
 *
 *   planned   the run OWES this case and has not begun it. Written for the whole
 *             corpus before any work, so a case the run never reaches is a row
 *             rather than an absence. An absence cannot be counted, and a report
 *             whose states do not sum to the corpus can call an unfinished run
 *             finished.
 *   started   the episode is in flight. Its `activity` tally is written as the
 *             episode's own events land, so an interrupted case still says what
 *             it got through. A restart finds it and re-runs it — after marking
 *             it `incomplete` first, because an attempt that was interrupted is
 *             a fact about the run worth keeping.
 *   progress  the episode FINISHED; its output and its `outcome` are stored
 *             here. The most expensive work is done; a restart adopts the stored
 *             output and never re-runs the episode.
 *   settled   the observation was fully recorded downstream. A restart skips it
 *             entirely — no re-run, no re-adoption.
 *   incomplete the case began and never settled: the operator cancelled, or the
 *             process died under it. Recorded, published as `incomplete`, never
 *             scored — an interruption is not a pass or a fail.
 *
 * {@link EvalProgressStore.census} partitions the corpus over exactly five
 * terminal states — scored, inert, errored, incomplete, not-run — so a run
 * reports counts that sum to what it owed rather than to whatever it managed,
 * and an unfinished run cannot read as a green one.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { JsonValueSchema, type JsonValue } from '@kinu.run/core';

const FILE_NAME = 'eval-progress.json';
const SCHEMA = 1;

/** One case's phase. */
export const CasePhaseSchema = v.picklist([
  'planned', 'started', 'progress', 'settled', 'incomplete',
]);
export type CasePhase = v.InferOutput<typeof CasePhaseSchema>;

/** How a case that RAN ended. Deliberately the same three words the run record
 *  uses for an observation, so nobody has to translate between the store's
 *  vocabulary and the record's. Cancellation is absent on purpose: it is a
 *  phase, not an outcome, because a cancelled episode produced no verdict to
 *  classify. */
export const CaseOutcomeSchema = v.picklist(['scored', 'inert', 'errored']);
export type CaseOutcome = v.InferOutput<typeof CaseOutcomeSchema>;

/** What one case has DONE so far, counted from the episode's own events as they
 *  landed. Present on an interrupted case as much as a finished one, which is
 *  the whole point of writing it during the episode rather than after it. */
export interface CaseActivity {
  turns: number;
  toolCalls: number;
  modelSteps: number;
}

/** What one case has produced so far. `output` is the harness's own wire shape,
 *  stored verbatim at `progress` so a restart can adopt it without re-running. */
export interface CaseRecord {
  taskId: string;
  repetition: number;
  phase: CasePhase;
  updatedAt: string;
  /** Why a case is `incomplete`. Present on that phase alone. */
  reason?: string;
  /** How the episode ended. Present from `progress` onward. */
  outcome?: CaseOutcome;
  /** The live tally, written as the episode's events land. */
  activity?: CaseActivity;
  /** The finished episode's JSON output, present from `progress` onward. */
  output?: JsonValue;
}

interface ProgressFileV1 {
  schema: 1;
  /** The run identity this state belongs to — family, tier, model, repeats,
   *  seed and corpus digest. A mismatch means the stored state belongs to a
   *  different run shape and must not be resumed into. */
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

/** The pairing key, identical in shape to `observationKey` in eval-run.ts but
 *  spelled here so the store carries no import from the record module. */
export function caseKey(taskId: string, repetition: number): string {
  return `${taskId}#${String(repetition)}`;
}

/** Parse the store's own file format at its one trust boundary. Every field used
 * by resume planning is checked before it reaches a typed record. */
function readProgressFile(path: string): ProgressFileV1 | null {
  const parsed = v.safeParse(ProgressFileV1Schema, JSON.parse(readFileSync(path, 'utf8')));
  return parsed.success ? parsed.output : null;
}

/**
 * Open (or create) the progress store inside `dir`.
 *
 * Existing state is adopted only when its {@link signature} matches: progress
 * belongs to one run shape, and resuming across a changed corpus or arm would
 * mix observations taken under different conditions into one record.
 */
export function openEvalProgress(dir: string, signature: string): EvalProgressStore {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, FILE_NAME);
  let cases: Record<string, CaseRecord> = {};

  if (existsSync(path)) {
    const parsed = readProgressFile(path);
    if (parsed?.signature === signature) cases = parsed.cases;
    // A mismatched or unreadable file starts fresh: stale state must never be
    // mistaken for this run's progress, and overwriting it loses nothing that
    // this run could have used.
  }
  return new EvalProgressStore(path, signature, cases);
}
/** Find the newest unfinished run directory of this exact shape.
 *
 * Completed runs are evidence and stay immutable; a new invocation starts a new
 * directory. An unfinished run resumes in place. Signature and expected keys are
 * both checked, so neither a changed corpus nor a shorter case list can turn an
 * old partial run into this run's progress.
 */
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

/** The identifying fields each case provides to the progress store. */
export interface EvalProgressCase {
  readonly taskId: string;
  readonly repetition: number;
}

/** One complete episode that a resumed run can adopt without repeating it. */
export interface AdoptableEvalCase<T extends EvalProgressCase> {
  readonly input: T;
  readonly output: JsonValue;
}

/** Work still required and finished episodes available for adoption. */
export interface EvalProgressPlan<T extends EvalProgressCase> {
  readonly todo: T[];
  readonly adopt: Array<AdoptableEvalCase<T>>;
}

/**
 * The five states a declared case can be in when a run reports.
 *
 * Exhaustive by construction: every case in the corpus lands in exactly one, so
 * the counts sum to what the run OWED rather than to whatever it managed. That
 * sum is the property a partial run cannot satisfy quietly — before it existed,
 * a repetition the run never reached was simply absent from the record, and a
 * shorter denominator read as a finished measurement.
 */
export type CaseState = 'scored' | 'inert' | 'errored' | 'incomplete' | 'notRun';

/** Every declared case partitioned across {@link CaseState}. */
export interface EvalCaseCensus<T extends EvalProgressCase = EvalProgressCase> {
  /** The corpus size, and the sum of the five state lists. */
  readonly total: number;
  /** Every case reached a verdict: nothing interrupted, nothing unreached. The
   *  one predicate every caller checks before treating a run as finished. */
  readonly complete: boolean;
  readonly states: Readonly<Record<CaseState, readonly T[]>>;
}

/** Which of the five states a stored record is in.
 *
 * `started` counts as `incomplete`: a case still in flight when the run reports
 * began and never settled, which is the same fact about the evidence as an
 * operator cancelling it. The record's `reason` is what distinguishes them.
 */
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
      // A completed record that lost its outcome is a broken record. `errored`
      // is the only bucket that neither claims a score nor claims cancellation.
      return record.outcome ?? 'errored';
  }
}

/**
 * The five-state block a run prints when it reports.
 *
 * The counts sum to the corpus by construction, and an unfinished run says so
 * in words rather than leaving a reader to subtract one number from another.
 */
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

  /** The record for one case, or undefined when the store has never seen it. */
  record(key: string): CaseRecord | undefined {
    return this.cases[key];
  }

  /** Every recorded case, keyed. Read-only view for reporting. */
  all(): Readonly<Record<string, CaseRecord>> {
    return this.cases;
  }

  /** Cases whose episode finished and whose output a restart can adopt. */
  adoptable(): Array<{ key: string; record: CaseRecord }> {
    return Object.entries(this.cases)
      .filter(([, r]) => r.phase === 'progress')
      .map(([key, record]) => ({ key, record }));
  }

  /** Cases already fully recorded downstream — a restart skips these. */
  settledKeys(): ReadonlySet<string> {
    return new Set(
      Object.entries(this.cases).filter(([, r]) => r.phase === 'settled').map(([k]) => k),
    );
  }

  /**
   * Record the whole corpus BEFORE any work begins.
   *
   * A case the run never reaches is then a `planned` row rather than an
   * absence, so the store file by itself states what the run owed and
   * {@link census} can count what it did not do. Cases already recorded are
   * left exactly as they are: this is the resume path's first write, not a
   * reset. One flush for the whole corpus, because none of these rows is
   * evidence yet.
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

  /** The episode is in flight. Any tally from an earlier attempt is dropped: a
   *  restart re-runs the case from the beginning, so its counts start over. */
  markStarted(key: string): void {
    this.set(key, { taskId: taskIdOf(key), repetition: repetitionOf(key), phase: 'started' });
  }

  /**
   * Add one of the episode's own events to the case's running tally, durably.
   *
   * Driven from the live event stream rather than read off the ledger at the
   * end, so a case the process dies under still says what it got through. The
   * events themselves are persisted where they always were — this is the count
   * a reader of the run's own state sees without reopening the ledger.
   */
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

  /** The episode finished; carry its output and how it ended so a restart adopts
   *  rather than repeats. Written immediately — this is the moment the expensive
   *  work becomes durable. The tally survives it: what the episode did is a fact
   *  about the episode, not about the reporting that follows. */
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
    // Keep a progress record's output beside the settle stamp: adoption reads
    // `phase === 'settled'`, and nothing needs the bytes again, but the store is
    // also the only surviving copy of the episode if downstream persistence is
    // interrupted. The outcome and the tally travel with it for the same reason
    // — the census reads them, and a settled case that forgot how it ended
    // cannot be counted at all.
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

  /** Record that a case will not produce a verdict — it began and never settled.
   *  Never carries an outcome: an interruption is not pass, fail or inert. What
   *  the attempt got through is kept, because it is the only evidence left of
   *  what that spend bought. */
  markIncomplete(key: string, reason: string): void {
    const record: Omit<CaseRecord, 'updatedAt'> = {
      taskId: taskIdOf(key), repetition: repetitionOf(key),
      phase: 'incomplete', reason,
    };
    const activity = this.cases[key]?.activity;
    if (activity) record.activity = activity;
    this.set(key, record);
  }

  /** Mark every in-flight (`started`) case incomplete — the cancellation path.
   *  `progress` records are deliberately untouched: their episodes finished,
   *  and a cancelled run must not unwrite completed work. */
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

  /** Partition a full case list into what a (re)start should do with each. */
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

  /**
   * What state every declared case is in, as one exhaustive partition.
   *
   * The corpus is the denominator, not the observation list: a case this run
   * never reached is `notRun` here, which is exactly the state that used to be
   * invisible. Takes the caller's own case objects and hands them back, like
   * {@link plan}, so a reporter never re-derives a key it already holds.
   */
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

  /** Write-through flush. Called after every mutation via {@link set}, and safe
   *  to call again before handing control to anything that might die. */
  flush(): void {
    if (!this.dirty) return;
    const payload: ProgressFileV1 = {
      schema: SCHEMA, signature: this.signature, cases: this.cases,
    };
    // Temp + rename: a crash mid-write leaves the previous complete state, not
    // a truncated file that reads as no progress at all.
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
