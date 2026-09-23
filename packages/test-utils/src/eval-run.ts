/**
 * What one eval run was, recorded so later runs can be compared against it. A run is not admissible
 * evidence until the harness asserts the outcome was measured, not merely configured. The observation
 * union and pairing key follow pi's vitest-evals collector; statistics live in packages/core/src/bench.
 */
import { execFileSync } from 'node:child_process';
import * as v from 'valibot';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { recordNoModelEpisode, recordUnmeasuredEpisode, recordWorkspaceSpend, type LiveModelSpend } from './live-model';
import {
  BUILTIN_TOOLS, classifyToolFailure, DEFAULT_WORKERS_AI_MODEL_ID, minimumPairsForSignificance, requiredPairs,
  type ActorHandle, type Clock, type RunEvent, type SqlExecutor, type WorkspaceSpend, type ToolOutcome,
} from '@kinu.run/core';
import { gitEnv } from './git';
import { BEHAVIOUR_SCORERS, type BehaviourScorer } from './agent-evals';
import { TASK_OUTCOME, isCovariateRow, type EvalSubgoal } from './eval-outcome';
import { compareRunEventOrder } from './eval-target';

/**
 * The DeepSeek arms, read from the live model catalogue (flash is not derivable from pro: `-0813` vs
 * `-0731`). Flash for high-volume stats, pro for upper bounds. `product` is imported from core's default,
 * the arm `gate:trajectory` runs on after a deploy.
 */
export const EVAL_MODELS = {
  flash: '@cf/deepseek-ai/deepseek-v4-flash-0731',
  pro: '@cf/deepseek-ai/deepseek-v4-pro-0813',
  product: DEFAULT_WORKERS_AI_MODEL_ID,
} as const satisfies Record<string, string>;

export type EvalTier = keyof typeof EVAL_MODELS;

/** Every optional mechanism's position; `evolution` matters because `noAutoEvolve` can silently disable learning. */
export interface EvalArmState {
  /** Auto-evolution wired on: the inverse of LocalAgentSession's noAutoEvolve. */
  readonly evolution: boolean;
  readonly settle: string;
  readonly tools: readonly string[];
  /** Absent: as written. */
  readonly prompt?: EvalPromptStyle;
}

export type EvalPromptStyle = 'caveman' | 'use-swarm';

export const FULL_TOOL_SURFACE: readonly string[] = [...BUILTIN_TOOLS];

/** pi's outcome union: a score exists only when scored. `incomplete` is no verdict (cancelled, crashed,
 *  or killed by the environment); the run still owes the case, so a restart retries it. */
export type EvalOutcome = 'scored' | 'inert' | 'errored' | 'skipped' | 'incomplete';

export interface EvalScoreRow {
  readonly name: string;
  readonly asserts: string;
  readonly eligible: number;
  readonly passed: number;
  readonly rate: number | null;
  readonly detail: string;
  readonly measured?: Readonly<Record<string, number>>;
}

/** One run event in an observation's provenance slice: structural facts only, no prompt, args, results or text. */
export interface EvalProvenanceEvent {
  readonly runId: string;
  readonly timestamp: string;
  readonly eventIndex: number;
  readonly type: string;
  readonly name?: string;
  readonly durationMs?: number;
  /** Why a tool call failed, as its class (`exit_127`, `threw`, `denied`, …), never its text. */
  readonly failureClass?: string;
  readonly outcome?: ToolOutcome;
}

/** A bounded slice of one observation's run-event ledger; `bound` and `totalEvents` distinguish full from clipped. */
export interface EvalRunProvenance {
  readonly totalEvents: number;
  readonly bound: number;
  readonly events: readonly EvalProvenanceEvent[];
}

export const PROVENANCE_EVENT_BOUND = 500;

/**
 * An episode's run-event trail in time order, bounded, with prompt, args, results, messages, error text and
 * model prose dropped. Over events, not a store, so local and public-plane families share it.
 */
export function projectRunEventProvenance(events: readonly RunEvent[]): EvalRunProvenance {
  const projected = [...events].sort(compareRunEventOrder).map((event): EvalProvenanceEvent => {
    const base = {
      runId: event.runId, timestamp: event.timestamp, eventIndex: event.eventIndex, type: event.type,
    };

    if (event.type !== 'tool_call_end') return base;

    // `undefined` for an unreported duration or clean call, so `JSON.stringify` omits the key.
    return {
      ...base, name: event.name, durationMs: event.durationMs,
      failureClass: classifyToolFailure(event)?.reason,
      outcome: event.outcome,
    };
  });

  return {
    totalEvents: projected.length,
    bound: PROVENANCE_EVENT_BOUND,
    events: projected.slice(0, PROVENANCE_EVENT_BOUND),
  };
}

/**
 * What a public-plane episode leaves behind: ledger, transcript and verdicts. A deployed workspace's store
 * lives in a Durable Object, so these route copies are the only ones this process holds.
 */
export interface EpisodeTranscript {
  readonly events: readonly RunEvent[];
  readonly history: readonly { readonly role: string; readonly text: string }[];
  readonly subgoals: readonly EvalSubgoal[];
}

/** The files of one retained episode: ledger as JSON lines (a clipped read stays parseable), transcript and verdicts. */
export const EPISODE_TRANSCRIPT_FILES = {
  events: 'events.jsonl', history: 'history.json', subgoals: 'subgoals.json',
} as const;

/** Retain one episode's transcript under `<transcripts>/<taskId>/`, before subgoals are asserted, and return it. */
export function retainEpisodeTranscript(
  transcripts: string, taskId: string, transcript: EpisodeTranscript,
): string {
  const dir = join(transcripts, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, EPISODE_TRANSCRIPT_FILES.events),
    transcript.events.map((event) => JSON.stringify(event)).join('\n') + (transcript.events.length > 0 ? '\n' : ''),
  );
  writeFileSync(join(dir, EPISODE_TRANSCRIPT_FILES.history), `${JSON.stringify(transcript.history, null, 2)}\n`);
  writeFileSync(join(dir, EPISODE_TRANSCRIPT_FILES.subgoals), `${JSON.stringify(transcript.subgoals, null, 2)}\n`);

  return dir;
}

export interface EpisodeEvidenceReader {
  runEvents(): Promise<readonly RunEvent[]>;
  history(): Promise<readonly { readonly role: string; readonly text: string }[]>;
  spend(): Promise<WorkspaceSpend>;
}

export interface EpisodeEvidence {
  readonly events: Awaited<ReturnType<EpisodeEvidenceReader['runEvents']>>;
  readonly history: Awaited<ReturnType<EpisodeEvidenceReader['history']>>;
  readonly spend: WorkspaceSpend;
}

/**
 * How long an evidence read may run after the episode budget is spent. A Durable Object wedged in an
 * unclosed turn serves its run-event, history and spend routes from that thread (2026-09-17, cba44dcb9: collect()
 * never returned after a 20-minute budget); healthy reads take tens of milliseconds. Unanswered channels are recorded.
 */
export const EVIDENCE_GRACE_MS = 60_000;

/** The evidence boundary starts before session opening; missing sessions leave unavailable channels, not empty data. */
export async function withEpisodeEvidence<Reader extends EpisodeEvidenceReader, T>(
  open: () => Promise<Reader>,
  options: {
    readonly transcripts: string; readonly taskId: string; readonly modelCalls: 'expected' | 'none';
    /** The budget runs on this clock (D19): production hands `REAL_CLOCK`, a test hands a `handClock` it
     *  advances, never a sleep racing a real timer. */
    readonly clock: Clock;
    /** The most wall time the operation may take once the session is open. When spent, the `budget` signal
     *  aborts, `failure.json` records `phase: 'budget'`, evidence is collected within {@link EVIDENCE_GRACE_MS},
     *  and the spend is thrown. */
    readonly budgetMs?: number;
  },
  operation: (reader: Reader, collect: () => Promise<EpisodeEvidence>, budget: AbortSignal) => Promise<T>,
): Promise<T> {
  const dir = join(options.transcripts, options.taskId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let reader: Reader;

  try {
    reader = await open();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    recordUnmeasuredEpisode();

    try {
      writeFileSync(join(dir, 'failure.json'), JSON.stringify({
        taskId: options.taskId, phase: 'open', name: failure.name, message: failure.message,
      }), { mode: 0o600 });
      writeFileSync(join(dir, 'collection.json'), JSON.stringify(
        ['events', 'history', 'spend'].map((channel) => ({ channel, status: 'unavailable', reason: 'session opening failed' })),
      ), { mode: 0o600 });
    } catch (retentionError) {
      throw new AggregateError([failure, retentionError], failure.message, { cause: retentionError });
    }

    throw failure;
  }

  const budget = new AbortController();
  /** Where the evidence read ends: {@link EVIDENCE_GRACE_MS} past the spent budget. Separate from `budget`. */
  const reading = new AbortController();

  /** One collection channel, abandoned at the read's end; a late answer is dropped, never an unhandled rejection. */
  const readChannel = <Value>(name: string, read: Promise<Value>): Promise<Value> => Promise.race([
    read,
    new Promise<never>((_resolve, reject) => {
      const abandon = (): void => {
        reject(new Error(`${options.taskId}: the ${name} channel had not answered `
          + `${String(EVIDENCE_GRACE_MS)} ms after the episode budget was spent`));
      };

      if (reading.signal.aborted) abandon();
      else reading.signal.addEventListener('abort', abandon, { once: true });
    }),
  ]);

  let collection: Promise<EpisodeEvidence> | null = null;

  const collect = (): Promise<EpisodeEvidence> => {
    collection ??= (async () => {
      const [events, history, spend] = await Promise.allSettled([
        readChannel('events', reader.runEvents()),
        readChannel('history', reader.history()),
        readChannel('spend', reader.spend()),
      ]);

      const errors: Error[] = [];
      const status: { channel: string; status: string; reason?: string }[] = [];

      if (spend.status === 'fulfilled') {
        if (options.modelCalls === 'none' && spend.value.total.calls === 0) {
          recordNoModelEpisode(spend.value);
        } else {
          recordWorkspaceSpend(spend.value);

          if (options.modelCalls === 'none' || spend.value.total.calls === 0) {
            errors.push(new Error(`${options.taskId}: expected model calls ${options.modelCalls}, observed ${spend.value.total.calls}`));
          }
        }

        writeFileSync(join(dir, 'spend.json'), JSON.stringify(spend.value, null, 2), { mode: 0o600 });
      } else {
        recordUnmeasuredEpisode();
      }

      if (events.status === 'fulfilled') {
        writeFileSync(join(dir, EPISODE_TRANSCRIPT_FILES.events),
          events.value.map((event) => JSON.stringify(event)).join('\n'), { mode: 0o600 });
      }

      if (history.status === 'fulfilled') {
        writeFileSync(join(dir, EPISODE_TRANSCRIPT_FILES.history), JSON.stringify(history.value, null, 2), { mode: 0o600 });
      }

      for (const [channel, result] of [['events', events], ['history', history], ['spend', spend]] as const) {
        if (result.status === 'fulfilled') {
          status.push({ channel, status: 'retained' });
        } else {
          const error = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
          errors.push(error);
          status.push({ channel, status: 'failed', reason: error.message });
        }
      }

      writeFileSync(join(dir, 'collection.json'), JSON.stringify(status, null, 2), { mode: 0o600 });

      if (errors.length > 0) throw new AggregateError(errors, errors.map((error) => error.message).join('; '));

      if (events.status !== 'fulfilled' || history.status !== 'fulfilled' || spend.status !== 'fulfilled') {
        throw new Error('Incomplete evidence collection');
      }

      return { events: events.value, history: history.value, spend: spend.value };
    })();

    return collection;
  };

  let result: { ok: true; value: T } | { ok: false; error: Error };
  /** Settles with the spend when the budget runs out; a value, so the race has no unread rejection. */
  const spent = Promise.withResolvers<{ readonly spent: Error }>();

  const disarm = options.budgetMs === undefined ? null : options.clock.after(options.budgetMs, () => {
    const reason = new Error(`${options.taskId}: the episode budget of ${String(options.budgetMs)} ms was spent before the operation ended`);
    budget.abort(reason);
    spent.resolve({ spent: reason });
  });

  const disarmReading = options.budgetMs === undefined
    ? null
    : options.clock.after(options.budgetMs + EVIDENCE_GRACE_MS, () => { reading.abort(); });

  try {
    const raced = await Promise.race([
      operation(reader, collect, budget.signal).then((value) => ({ value })),
      spent.promise,
    ]);

    if ('spent' in raced) throw raced.spent;
    result = { ok: true, value: raced.value };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    result = { ok: false, error: failure };
    writeFileSync(join(dir, 'failure.json'), JSON.stringify({
      name: failure.name, message: failure.message, ...(budget.signal.aborted && { phase: 'budget' }),
    }), { mode: 0o600 });
  } finally {
    if (disarm !== null) disarm();
  }

  try {
    await collect();
  } catch (error) {
    if (!result.ok) throw new AggregateError([result.error, error], result.error.message, { cause: error });
    throw error;
  } finally {
    if (disarmReading !== null) disarmReading();
  }

  if (!result.ok) throw result.error;

  return result.value;
}

/** One task attempted once. `repetition` plus `taskId` is the pairing identity. */
export type EvalObservation =
  | {
    readonly taskId: string;
    readonly repetition: number;
    readonly outcome: 'scored';
    readonly scores: readonly EvalScoreRow[];
    readonly turns: number;
    readonly toolCalls: number;
    /** The tools this attempt called, in order. Optional: flash-a/b records predate it; read with `?? []`. */
    readonly toolNames?: readonly string[];
    readonly tokensIn: number;
    readonly tokensOut: number;
    /** Reasoning tokens, when the provider reported them. Optional: flash-a/b predate it. */
    readonly reasoningOut?: number;
    readonly ms: number;
    /** Bounded run-event provenance; see {@link EvalRunProvenance}. Optional so older records stay readable. */
    readonly provenance?: EvalRunProvenance;
  }
  | {
    readonly taskId: string;
    readonly repetition: number;
    readonly outcome: Exclude<EvalOutcome, 'scored'>;
    readonly reason: string;
    readonly scores?: never;
  };

export function observationKey(o: Pick<EvalObservation, 'taskId' | 'repetition'>): string {
  return `${o.taskId}#${String(o.repetition)}`;
}

/**
 * Why a run is or is not admissible evidence. `outcomesScored` is what gates; mechanism coverage fields are
 * telemetry that explains a moved outcome and gate nothing.
 */
export interface EvalAdmissibility {
  readonly admissible: boolean;
  readonly scored: number;
  readonly inert: number;
  /** Turns recorded across the run. Zero graded turns means nothing was measured. */
  readonly gradedTurns: number;
  readonly toolCalls: number;
  /** Observations carrying a `task_outcome` row: attempts actually checked against ground truth. */
  readonly outcomesScored: number;
  readonly mechanismsExercised: readonly string[];
  readonly mechanismsAbsent: readonly string[];
  readonly failures: readonly string[];
  /** Observations cancellation caught mid-episode. Never scored; they mark the record partial. */
  readonly incomplete: number;
}

export interface EvalRunRecord {
  readonly schema: 1;
  readonly runId: string;
  readonly createdAt: string;
  /** The eval family (`behaviour`, `research`, `optimization`); `scripts/eval-report.ts` groups on it.
   *  Optional: flash-a/b predate it, and absence reads as pre-family. */
  readonly family?: string;
  /** The commit under test and whether the tree was dirty; a dirty tree makes a run unreproducible. */
  readonly gitSha: string;
  readonly gitDirty: boolean;
  readonly tier: EvalTier;
  readonly modelId: string;
  /** The single model the ledger observed serving turns ({@link modelObservedFromEvents}), else null.
   *  `assessAdmissibility` refuses a record whose non-null observed model differs from `modelId`.
   *  Optional so older records stay readable; absence is not agreement. */
  readonly modelObserved?: string | null;
  readonly repeats: number;
  readonly seed: number;
  readonly arm: EvalArmState;
  readonly declaredTasks: readonly string[];
  readonly executedTasks: readonly string[];
  readonly observations: readonly EvalObservation[];
  readonly admissibility: EvalAdmissibility;
  readonly spend: { readonly calls: number; readonly tokensIn: number; readonly tokensOut: number };
  /**
   * Directory holding the run's agent stores, the trajectories scores came from. Required; swept locations
   * like `/tmp` are refused by `resolveArtifactRoot` (scripts/bench-retention.ts).
   */
  readonly transcripts: string;
}

/** What this design can resolve, computed before anything is spent: 2 differing pairs cannot beat p = 0.5. */
export interface EvalPreRegistration {
  readonly tasks: number;
  readonly repeats: number;
  readonly pairs: number;
  readonly minimumPairs: number;
  readonly dispersion: number;
  /** False when `dispersion` is the neutral 0.5 assumption rather than measured by running one arm twice. */
  readonly dispersionMeasured: boolean;
  /** Tasks needed to resolve a 10 / 20 percentage-point effect at 80% power. */
  readonly pairsFor10pp: number;
  readonly pairsFor20pp: number;
  readonly canReachSignificance: boolean;
  readonly note: string;
}

/**
 * @param measuredDispersion ψ from running one arm twice on this corpus (`scripts/eval-dispersion.ts`).
 *   Omitted: the neutral 0.5 is used and labelled as assumed.
 */
export function preRegister(
  tasks: number, repeats: number, measuredDispersion?: number,
): EvalPreRegistration {
  const minimumPairs = minimumPairsForSignificance();
  const dispersionMeasured = measuredDispersion !== undefined && measuredDispersion > 0;
  const dispersion = dispersionMeasured ? measuredDispersion : 0.5;
  const pairsFor10pp = requiredPairs(0.10, { dispersion });
  const pairsFor20pp = requiredPairs(0.20, { dispersion });
  const canReachSignificance = tasks >= minimumPairs;

  const basis = dispersionMeasured
    ? `psi ${dispersion.toFixed(6)} MEASURED on this corpus`
    : `psi ${dispersion.toFixed(2)} ASSUMED — no same-arm pair measured yet`;

  return {
    tasks, repeats, pairs: tasks, minimumPairs, dispersion, dispersionMeasured,
    pairsFor10pp, pairsFor20pp, canReachSignificance,
    note: canReachSignificance
      ? `${String(tasks)} pairs can reach significance; resolving 20pp at 80% power needs `
        + `${String(pairsFor20pp)} (${basis})`
      : `${String(tasks)} pairs CANNOT reach significance at any effect size — `
        + `${String(minimumPairs)} is the floor (${basis})`,
  };
}

/** Score every behavioural instrument against one store. A throwing scorer propagates: a corrupt ledger is not an absent mechanism. */
export function scoreTrajectory(
  sql: SqlExecutor, actor: ActorHandle, scorers: readonly BehaviourScorer[] = BEHAVIOUR_SCORERS,
): EvalScoreRow[] {
  return scorers.map((scorer) => {
    const score = scorer.score(sql, actor);

    return { ...score, name: scorer.name, asserts: scorer.asserts };
  });
}

/**
 * The model a run's ledger observed serving its turns, or null unless exactly one serving id appears.
 * `step_finish` rows only: `model_call` rows include judges and auxiliary lanes on other models by design.
 */
export function modelObservedFromEvents(events: readonly RunEvent[]): string | null {
  const seen = new Set<string>();
  collectServingIds(events, seen);

  return seen.size === 1 ? [...seen][0] ?? null : null;
}

function collectServingIds(events: readonly RunEvent[], seen: Set<string>): void {
  for (const event of events) {
    // CLI steps carry no modelId; their agent operations do.
    const serving = event.type === 'step_finish'
      || (event.type === 'model_operation' && event.source === 'agent' && event.phase === 'end');

    if (serving && event.modelId !== undefined && event.modelId.length > 0) seen.add(event.modelId);
  }
}

/** The incremental form of {@link modelObservedFromEvents}, one accumulator per run, same single-or-null rule. */
export interface ObservedModelAccumulator {
  note(events: readonly RunEvent[]): void;
  readonly observed: string | null;
}

export function createObservedModelAccumulator(): ObservedModelAccumulator {
  const seen = new Set<string>();

  return {
    note(events: readonly RunEvent[]): void {
      collectServingIds(events, seen);
    },
    get observed(): string | null {
      return seen.size === 1 ? [...seen][0] ?? null : null;
    },
  };
}

export interface AdmissibilityModelClaim {
  readonly modelId: string;
  readonly modelObserved: string | null;
}

/** Whether an observed serving id disproves a claimed model; containment in either direction tolerates respelling. */
export function modelClaimRefuted(modelId: string, modelObserved: string | null): boolean {
  return modelObserved !== null
    && modelObserved !== modelId
    && !modelObserved.includes(modelId)
    && !modelId.includes(modelObserved);
}

/**
 * Is this run evidence? Strict on measurement, silent on quality: solving nothing is admissible, never
 * checking the outcome is not.
 */
export function assessAdmissibility(
  declaredTasks: readonly string[],
  observations: readonly EvalObservation[],
  model?: AdmissibilityModelClaim,
): EvalAdmissibility {
  const scored = observations.filter((o) => o.outcome === 'scored');
  const inert = observations.filter((o) => o.outcome === 'inert').length;
  const incomplete = observations.filter((o) => o.outcome === 'incomplete').length;
  const gradedTurns = scored.reduce((n, o) => n + o.turns, 0);
  const toolCalls = scored.reduce((n, o) => n + o.toolCalls, 0);

  const outcomesScored = scored
    .filter((o) => o.scores.some((s) => s.name === TASK_OUTCOME)).length;

  // Covariates only: the outcome row is not a mechanism.
  const exercised = new Set<string>();

  for (const o of scored) {
    for (const s of o.scores) if (s.eligible > 0 && isCovariateRow(s.name)) exercised.add(s.name);
  }

  const allNames = BEHAVIOUR_SCORERS.map((s) => s.name);

  const executed = new Set(observations.map((o) => o.taskId));
  const missing = declaredTasks.filter((id) => !executed.has(id));

  const failures: string[] = [];

  if (scored.length === 0) failures.push('no observation was scored — nothing to measure');

  if (gradedTurns === 0) failures.push('zero graded turns — the ledger recorded no closed turn');

  if (toolCalls === 0) failures.push('zero tool calls — no agent behaviour occurred');

  if (outcomesScored === 0 && scored.length > 0) {
    failures.push('no observation carried a task_outcome row — this run measured activity, '
      + 'not whether any task was solved, so it is not evidence about task performance');
  }

  if (missing.length > 0) {
    failures.push(`declared ${String(declaredTasks.length)} tasks but never attempted ${missing.join(', ')}`);
  }

  // A cancelled run is partial: settled work stands, but the record must say it is incomplete.
  if (incomplete > 0) {
    failures.push(`${String(incomplete)} case(s) never settled — the run was cancelled `
      + 'mid-flight; this record is partial evidence, not a verdict');
  }

  // The model claim must survive the ledger. Omitted means the caller never observed, so it cannot fail here.
  if (model !== undefined && modelClaimRefuted(model.modelId, model.modelObserved)) {
    failures.push(`run claimed model ${model.modelId} but the ledger observed `
      + `${model.modelObserved} serving its turns — the turns ran on a model the record does not name`);
  }

  return {
    admissible: failures.length === 0,
    scored: scored.length, inert, incomplete, gradedTurns, toolCalls, outcomesScored,
    mechanismsExercised: [...exercised].sort(),
    mechanismsAbsent: allNames.filter((n) => !exercised.has(n)),
    failures,
  };
}

export interface GitProvenance {
  readonly gitSha: string;
  readonly gitDirty: boolean;
}

/** Uses `gitEnv` so an exported GIT_DIR/GIT_WORK_TREE (e.g. the pre-push hook) cannot redirect this. */
export function gitProvenance(cwd: string): GitProvenance {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' }).trim();

  return { gitSha: git('rev-parse', 'HEAD'), gitDirty: git('status', '--porcelain') !== '' };
}

/** Everything a family's suite knows about its run; one assembly point for runId, git provenance,
 *  admissibility and spend across families. */
export interface RunRecordInputs {
  readonly family: string;
  readonly tier: EvalTier;
  readonly modelId: string;
  readonly modelObserved: string | null;
  readonly repeats: number;
  readonly seed: number;
  readonly arm: EvalArmState;
  readonly declaredTasks: readonly string[];
  readonly observations: readonly EvalObservation[];
  readonly spend: LiveModelSpend;
  readonly transcripts: string;
  readonly repoRoot: string;
}

function assembleRunRecord(inputs: RunRecordInputs): EvalRunRecord {
  return {
    schema: 1,
    runId: `${inputs.family}-${inputs.tier}-${String(Date.now())}`,
    createdAt: new Date().toISOString(),
    ...gitProvenance(inputs.repoRoot),
    family: inputs.family,
    tier: inputs.tier,
    modelId: inputs.modelId,
    modelObserved: inputs.modelObserved,
    repeats: inputs.repeats,
    seed: inputs.seed,
    arm: inputs.arm,
    declaredTasks: inputs.declaredTasks,
    executedTasks: [...new Set(inputs.observations.map((o) => o.taskId))],
    observations: inputs.observations,
    admissibility: assessAdmissibility(inputs.declaredTasks, inputs.observations, {
      modelId: inputs.modelId, modelObserved: inputs.modelObserved,
    }),
    // LiveModelSpend carries `usage: Usage`; flattened to tokensIn/tokensOut here.
    spend: {
      calls: inputs.spend.calls,
      tokensIn: inputs.spend.usage.input ?? 0,
      tokensOut: inputs.spend.usage.output ?? 0,
    },
    transcripts: inputs.transcripts,
  };
}

function writeRunRecord(path: string, record: EvalRunRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Publish a run's record, or say why there is none; the only writer. A run that attempted nothing gets no
 * record. Destination is `KINU_EVAL_RECORD` or the run's transcripts directory, never `tests/eval/runs/`:
 * that dirties the checkout and `deploy.sh` refuses a dirty tree. Returns the record, or null.
 */
export function publishRunRecord(inputs: RunRecordInputs): EvalRunRecord | null {
  if (inputs.observations.length === 0) {
    console.warn(`\nNO RECORD: the ${inputs.family} run attempted 0 of `
      + `${String(inputs.declaredTasks.length)} declared task(s), so it measured nothing and `
      + 'the corpus takes no record of it. Every case skipped — with no credential that is '
      + "the tier's normal credential-free pass, and `[skip]` above says which reason.\n");

    return null;
  }

  const record = assembleRunRecord(inputs);
  const out = process.env.KINU_EVAL_RECORD ?? join(inputs.transcripts, 'run-record.json');
  writeRunRecord(out, record);
  console.log(`\n${formatRunRecord(record)}\n\nrecord: ${out}\n`);

  return record;
}

/** The version marker every stored record must carry, validated so a schema bump fails loudly. Schema 1 is
 *  only produced by `writeRunRecord`, so the envelope is the record's identity. */
const RunRecordSchema = v.custom<EvalRunRecord>(
  (raw) => v.is(v.looseObject({ schema: v.literal(1) }), raw),
  'not an eval run record of schema 1',
);

export function readRunRecord(path: string): EvalRunRecord {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const record = v.safeParse(RunRecordSchema, raw);

  if (!record.success) {
    throw new Error(`${path}: ${record.issues.map((issue) => issue.message).join('; ')}`);
  }

  return record.output;
}

/** Every record path under a root (`<root>/<run>/run-record.json` or `<root>/*.json`), shared by eval-report and eval-triage. */
export function runRecordPaths(root: string): string[] {
  if (!existsSync(root)) return [];
  const paths: string[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const candidate = join(root, entry.name, 'run-record.json');

      if (existsSync(candidate)) paths.push(candidate);
    } else if (entry.name.endsWith('.json')) {
      paths.push(join(root, entry.name));
    }
  }

  return paths.sort();
}

function covariateRate(row: { eligible: number; passed: number; unmeasured: boolean }): string {
  if (row.unmeasured) {
    return `unmeasured — ${String(row.eligible)} observed opportunities, ${String(row.passed)} known successes`;
  }

  if (row.eligible === 0) return 'n/a — no eligible opportunity';

  return `${String(row.passed)}/${String(row.eligible)} = ${(row.passed / row.eligible).toFixed(3)}`;
}

/** A run record for a reader: what ran, whether it is evidence, the outcome, then labelled covariates. */
export function formatRunRecord(record: EvalRunRecord): string {
  const a = record.admissibility;

  const lines = [
    `run ${record.runId} — ${record.family ?? '(pre-family record)'}, `
      + `${record.tier} (${record.modelId})`,
    `  ledger observed: ${record.modelObserved ?? 'no serving model — the record carries no ledger check'}`,
    `  commit ${record.gitSha.slice(0, 9)}${record.gitDirty ? ' [DIRTY — unreproducible]' : ''}`,
    `  arm: evolution ${record.arm.evolution ? 'ON' : 'OFF'}, settle ${record.arm.settle}, `
      + `${String(record.arm.tools.length)} tools, prompt ${record.arm.prompt ?? 'as written'}`,
    `  tasks ${String(record.executedTasks.length)}/${String(record.declaredTasks.length)} `
      + `× ${String(record.repeats)} repeats, seed ${String(record.seed)}`,
    `  ADMISSIBLE: ${a.admissible ? 'yes' : 'NO'} — ${String(a.gradedTurns)} graded turns, `
      + `${String(a.toolCalls)} tool calls, ${String(a.scored)} scored / ${String(a.inert)} inert`
      + (a.incomplete > 0 ? ` / ${String(a.incomplete)} INCOMPLETE (cancelled)` : ''),
  ];

  for (const failure of a.failures) lines.push(`    INADMISSIBLE: ${failure}`);

  if (a.mechanismsAbsent.length > 0) {
    lines.push(`  never exercised: ${a.mechanismsAbsent.join(', ')}`);
  }

  lines.push(`  spend: ${String(record.spend.calls)} calls, `
    + `${String(record.spend.tokensIn)} in / ${String(record.spend.tokensOut)} out tokens`);

  const scoredObs = record.observations
    .filter((o): o is Extract<EvalObservation, { outcome: 'scored' }> => o.outcome === 'scored');

  const totals = (name: string) => {
    const rows = scoredObs.flatMap((o) => o.scores.filter((s) => s.name === name));
    const eligible = rows.reduce((n, r) => n + r.eligible, 0);
    const passed = rows.reduce((n, r) => n + r.passed, 0);

    return { eligible, passed, unmeasured: rows.some((row) => row.eligible > 0 && row.rate === null) };
  };

  const outcome = totals(TASK_OUTCOME);
  lines.push(`  OUTCOME — did the agent solve the task:`);
  lines.push(`    ${TASK_OUTCOME.padEnd(20)} ${outcome.eligible === 0 || outcome.unmeasured
    ? 'NOT MEASURED — ground truth or outcome attribution absent'
    : `${String(outcome.passed)}/${String(outcome.eligible)} = `
      + `${(outcome.passed / outcome.eligible).toFixed(3)} over `
      + `${String(a.outcomesScored)} scored attempts`}`);

  lines.push('  covariates (mechanism telemetry — explanatory, never a score):');

  for (const name of BEHAVIOUR_SCORERS.map((s) => s.name)) {
    lines.push(`    ${name.padEnd(20)} ${covariateRate(totals(name))}`);
  }

  return lines.join('\n');
}
