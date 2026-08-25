/**
 * Aggregation across repetitions, and the Markdown the report section is made
 * of. Pure: the driver hands it collected results and gets text back, so the
 * gate self-test pins the arithmetic and the wording without a container.
 *
 * ── Why the aggregation looks like this ─────────────────────────────────────
 *
 * The probe reports a SUMMARY per metric per repetition, not the raw latency
 * array. That is a deliberate limit: a 10,000-file phase produces 10,000
 * latencies per metric, and shipping them through a container exec's stdout for
 * every arm invites a truncated read that silently loses the tail — the exact
 * part of the distribution the p95 column exists to show.
 *
 * So there are two levels of dispersion and they answer different questions:
 *
 *   WITHIN a repetition — the probe's own p50/p95/p99 over individual
 *   operations. This is what an operation feels like.
 *
 *   ACROSS repetitions — computed here over the per-repetition medians. This is
 *   whether the arm is reproducible, and it is the number that decides whether
 *   two arms may be compared at all.
 *
 * A run that reports a fast median with an across-repetition CV of 0.6 has not
 * measured a fast filesystem; it has measured a filesystem that is sometimes
 * fast. The renderer says so instead of ranking it.
 */

import * as v from 'valibot';

import { isUnstable, summarize, type Summary } from './stats';
import {
  REJECTED_S3FS_OPTIONS, SDK_DEFAULT_R2_S3FS_OPTIONS, SDK_FORCED_S3FS_OPTIONS,
  TUNED_S3FS_OPTIONS, type LayoutId,
} from './layouts';

export interface ProbeMetric {
  readonly name: string;
  readonly summary: Summary;
  readonly wallMs: number;
  readonly bytes?: number;
  readonly throughputMiBs?: number;
  readonly ops?: number;
}

export interface ProbeVerdict {
  readonly name: string;
  readonly holds: boolean;
  readonly detail: string;
}

export interface ProbePhase {
  readonly phase: string;
  readonly status: 'ok' | 'failed';
  readonly wallMs: number;
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
  /** The slice of the run's budget each timed group in THIS phase received. The
   *  divisor is a structural fact about the phase, so the share belongs on the
   *  phase rather than on the run: a multi-phase payload carries several. Absent
   *  means the phase has no timed group and nothing was bounded, which is a real
   *  state rather than a missing value, and absent on an archived run means it
   *  predates the per-phase budget. */
  readonly loopBudgetShareMs?: number;
  readonly metrics: readonly ProbeMetric[];
  readonly verdicts: readonly ProbeVerdict[];
  readonly error?: string;
}

export interface ProbeRun {
  readonly schema: string;
  readonly root: string;
  readonly seed: number;
  /** The per-loop time budget the probe ran under, which bounds the sample
   *  count behind every summary below. The probe has always emitted it and it
   *  is archived with the run; declaring it is what stops the boundary from
   *  dropping it. */
  readonly loopBudgetMs: number;
  /** Whether that budget bounded the whole phase or each measured loop inside
   *  it. Optional because the probe did not always emit it, and an archived run
   *  without it really was scoped per loop — reading its absence as `'loop'` is
   *  the truth about that artifact, not a default standing in for one. */
  readonly loopBudgetScope?: 'phase' | 'loop';
  readonly phases: readonly ProbePhase[];
  readonly facts?: Readonly<Record<string, string>>;
}

/**
 * The probe's wire contract, at the one boundary where its JSON becomes typed.
 *
 * The probe runs inside the container and prints ONE object on stdout; the
 * drivers read it back over a container exec. Declaring the schema against the
 * interface rather than inferring the interface from the schema keeps the
 * documented type the source of truth and makes a drifted field a compile
 * error here, where the two are side by side.
 */
const SummarySchema: v.GenericSchema<Summary> = v.object({
  n: v.number(),
  min: v.number(),
  p50: v.number(),
  p95: v.number(),
  p99: v.number(),
  max: v.number(),
  mean: v.number(),
  stddev: v.number(),
  cv: v.number(),
});

const ProbeMetricSchema: v.GenericSchema<ProbeMetric> = v.object({
  name: v.string(),
  summary: SummarySchema,
  wallMs: v.number(),
  bytes: v.optional(v.number()),
  throughputMiBs: v.optional(v.number()),
  ops: v.optional(v.number()),
});

const ProbeVerdictSchema: v.GenericSchema<ProbeVerdict> = v.object({
  name: v.string(),
  holds: v.boolean(),
  detail: v.string(),
});

const ProbePhaseSchema: v.GenericSchema<ProbePhase> = v.object({
  phase: v.string(),
  status: v.picklist(['ok', 'failed']),
  wallMs: v.number(),
  cpuUserMs: v.number(),
  cpuSystemMs: v.number(),
  loopBudgetShareMs: v.optional(v.number()),
  metrics: v.array(ProbeMetricSchema),
  verdicts: v.array(ProbeVerdictSchema),
  error: v.optional(v.string()),
});

export const ProbeRunSchema: v.GenericSchema<ProbeRun> = v.object({
  schema: v.string(),
  root: v.string(),
  seed: v.number(),
  loopBudgetMs: v.number(),
  loopBudgetScope: v.optional(v.picklist(['phase', 'loop'])),
  phases: v.array(ProbePhaseSchema),
  facts: v.optional(v.record(v.string(), v.string())),
});

/**
 * Decode one probe payload. `source` names where the text came from, because a
 * malformed probe payload is a benchmark failure and the operator has to know
 * which exec produced it. Both failure paths carry the wire's own words: the
 * JSON syntax error or valibot's field-level message, plus a prefix of the text
 * itself. Nothing is defaulted — a run that cannot read its probe has no
 * numbers, and saying so is the only honest outcome.
 */
export function parseProbeRun(text: string, source: string): ProbeRun {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${source}: probe payload is not JSON: ${error instanceof Error ? error.message : String(error)}`
      + `\n${text.slice(0, 400)}`,
      { cause: error },
    );
  }
  const result = v.safeParse(ProbeRunSchema, decoded);
  if (!result.success) {
    throw new Error(
      `${source}: probe payload does not match the probe contract: `
      + result.issues.map((issue) => `${v.getDotPath(issue) ?? '<root>'}: ${issue.message}`).join('; ')
      + `\n${text.slice(0, 400)}`,
    );
  }
  return result.output;
}

export interface OpTally {
  readonly calls: Readonly<Record<string, number>>;
  readonly classA: number;
  readonly classB: number;
  /** Deletes and multipart aborts: counted, billed at nothing, never hidden,
   *  because the phases that decide this benchmark are dominated by them. */
  readonly classFree: number;
  readonly total: number;
}

/**
 * One line of the explicit-sync report. The three producers — the built-in
 * stand-in, the sibling CLI and the failure record — each emit their own set of
 * counters, so the set is not closed; what IS closed is how a line renders. The
 * tag is applied where the payload is decoded, so the renderer branches on a
 * domain value instead of re-inspecting a representation it was handed.
 */
export type SyncMeasurement =
  | { readonly name: string; readonly kind: 'count'; readonly count: number }
  | { readonly name: string; readonly kind: 'note'; readonly note: string };

/** What one arm's explicit sync reported. */
export interface SyncOutcome {
  /** Which implementation produced the measurements. */
  readonly implementation: string;
  /** Set only when the sync emitted no JSON, and then it carries the wire's own
   *  stderr rather than a substituted message. */
  readonly error: string | null;
  readonly measurements: readonly SyncMeasurement[];
}

/**
 * What a sync implementation is allowed to print.
 *
 * A scalar, a list of scalars, or ONE level of nested scalars. All three occur:
 * `noop` is a boolean, `invalidatedPaths` is a list, and the sibling CLI reports
 * its per-call R2 counters under a nested `store` object. The driver used to
 * assume number-or-string, which admitted the boolean by accident and rendered
 * the whole `store` object as `[object Object]` — eight R2 operation counts
 * erased from the report of a benchmark whose subject is R2 operation counts.
 */
const SyncScalarSchema = v.union([v.number(), v.string(), v.boolean()]);
const SyncPayloadSchema = v.record(
  v.string(),
  v.union([SyncScalarSchema, v.array(SyncScalarSchema), v.record(v.string(), SyncScalarSchema)]),
);

/** A list renders as its comma-join, which is what the previous reader printed
 *  for the same value. A nested group renders as one dotted line per counter. */
function tagScalar(name: string, value: number | string | boolean): SyncMeasurement {
  return v.is(v.number(), value)
    ? { name, kind: 'count', count: value }
    : { name, kind: 'note', note: String(value) };
}

/**
 * Tag one sync payload into report lines, in emit order. A number is a count the
 * renderer rounds; everything else is a note it prints verbatim.
 */
export function syncMeasurements(text: string, source: string): readonly SyncMeasurement[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${source}: sync payload is not JSON: ${error instanceof Error ? error.message : String(error)}`
      + `\n${text.slice(0, 400)}`,
      { cause: error },
    );
  }
  const result = v.safeParse(SyncPayloadSchema, decoded);
  if (!result.success) {
    throw new Error(
      `${source}: sync payload is not an object of scalars, scalar lists and scalar groups: `
      + result.issues.map((issue) => `${v.getDotPath(issue) ?? '<root>'}: ${issue.message}`).join('; ')
      + `\n${text.slice(0, 400)}`,
    );
  }
  const measurements: SyncMeasurement[] = [];
  for (const [name, value] of Object.entries(result.output)) {
    if (v.is(SyncScalarSchema, value)) {
      measurements.push(tagScalar(name, value));
    } else if (Array.isArray(value)) {
      measurements.push({ name, kind: 'note', note: String(value) });
    } else {
      for (const [inner, scalar] of Object.entries(value)) {
        measurements.push(tagScalar(`${name}.${inner}`, scalar));
      }
    }
  }
  return measurements;
}

/** Whether a seeded manifest survived a container restart, and how long the
 *  restart itself took. */
export interface DurabilityVerdict {
  readonly verdict: boolean;
  readonly detail: string;
  readonly restartMs: number;
}

export interface LayoutResult {
  readonly id: LayoutId;
  readonly label: string;
  readonly question: string;
  readonly root: string;
  readonly s3fsOptions: readonly string[];
  readonly readOnly: boolean | null;
  /** First mount of the arm, with nothing warm anywhere. */
  readonly mountColdMs: number | null;
  /** Unmount then mount again, same options. */
  readonly mountWarmMs: number | null;
  readonly mountError: string | null;
  readonly reps: readonly ProbeRun[];
  /** R2 API calls attributable to this arm's phases. */
  readonly ops: OpTally | null;
  /** Objects and bytes the arm left under the run prefix, before teardown. */
  readonly objectsAfter: number | null;
  readonly bytesAfter: number | null;
  /** Explicit-sync numbers, for the arm that needs one. */
  readonly sync: SyncOutcome | null;
  /** Whether a seeded manifest survived a container restart. */
  readonly durability: DurabilityVerdict | null;
  readonly notes: readonly string[];
}

export interface RunArtifact {
  readonly schema: 'r2-bench/run@1';
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly repetitions: number;
  readonly seed: number;
  readonly mode: string;
  readonly bucket: string;
  readonly keyPrefix: string;
  readonly versions: Readonly<Record<string, string>>;
  /** Kernel, cpus, memory, filesystems and tool versions, exactly as the
   *  container reported them. Provenance for every number in this artifact. */
  readonly containerFacts: string;
  readonly layouts: readonly LayoutResult[];
  readonly teardown: Readonly<Record<string, number | string | boolean>>;
  readonly conditions: readonly string[];
}

/** One metric, aggregated over every repetition of one arm. */
export interface MetricAggregate {
  readonly name: string;
  /** Median of the per-repetition medians, and the spread of those medians. */
  readonly acrossReps: Summary;
  /** Median of the per-repetition p95s. */
  readonly p95OfReps: number;
  /** Median of the per-repetition throughputs, when the metric moves bytes. */
  readonly throughputMiBs: number | null;
  readonly ops: number | null;
  readonly reps: number;
  readonly unstable: boolean;
}

const median = (values: readonly number[]): number => summarize(values).p50;

/** Every metric of ONE arm, keyed by metric name. */
export type MetricAggregates = Map<string, MetricAggregate>;

/** Every arm's aggregates, keyed by arm. The shape the renderer and the
 *  recommendation both consume, named here because both are exported and a
 *  caller should not have to reach through a function to describe it. */
export type LayoutAggregates = Map<LayoutId, MetricAggregates>;

export function aggregate(reps: readonly ProbeRun[]): MetricAggregates {
  const perMetric = new Map<string, { medians: number[]; p95s: number[]; throughputs: number[]; ops: number | null }>();
  for (const run of reps) {
    for (const phase of run.phases) {
      for (const metric of phase.metrics) {
        const bucket = perMetric.get(metric.name) ?? { medians: [], p95s: [], throughputs: [], ops: null };
        bucket.medians.push(metric.summary.p50);
        bucket.p95s.push(metric.summary.p95);
        if (metric.throughputMiBs !== undefined) bucket.throughputs.push(metric.throughputMiBs);
        if (metric.ops !== undefined) bucket.ops = metric.ops;
        perMetric.set(metric.name, bucket);
      }
    }
  }
  const out = new Map<string, MetricAggregate>();
  for (const [name, bucket] of perMetric) {
    const acrossReps = summarize(bucket.medians);
    out.set(name, {
      name,
      acrossReps,
      p95OfReps: median(bucket.p95s),
      throughputMiBs: bucket.throughputs.length > 0 ? median(bucket.throughputs) : null,
      ops: bucket.ops,
      reps: bucket.medians.length,
      unstable: isUnstable(acrossReps),
    });
  }
  return out;
}

/** Every verdict any repetition produced, with disagreement between repetitions
 *  surfaced rather than collapsed: an invariant that holds four times out of
 *  five is a worse result than one that never holds. */
export function verdictTable(reps: readonly ProbeRun[]): { name: string; held: number; of: number; detail: string }[] {
  const seen = new Map<string, { held: number; of: number; detail: string }>();
  for (const run of reps) {
    for (const phase of run.phases) {
      for (const verdict of phase.verdicts) {
        const row = seen.get(verdict.name) ?? { held: 0, of: 0, detail: verdict.detail };
        row.of += 1;
        if (verdict.holds) row.held += 1;
        else row.detail = verdict.detail;
        seen.set(verdict.name, row);
      }
    }
  }
  return [...seen].map(([name, row]) => ({ name, ...row })).sort((a, b) => a.name.localeCompare(b.name));
}

const num = (value: number, digits = 2): string => {
  if (!Number.isFinite(value)) return 'n/a';
  if (value === 0) return '0';
  if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString('en-US');
  return value.toFixed(digits);
};

const cell = (value: number | null, digits = 2): string => (value === null ? '—' : num(value, digits));

/**
 * Metrics printed in the headline table, in the order the acceptance criterion
 * names them. A metric absent from an arm prints as an em dash rather than as a
 * zero, because a missing measurement and a measurement of zero are different
 * claims.
 */
export const HEADLINE_METRICS = [
  'write-1MiB', 'write-10MiB', 'write-100MiB',
  'read-1MiB', 'read-10MiB', 'read-100MiB',
  'reread-10MiB',
  'random-read-4KiB', 'random-write-4KiB',
  'small-create-1k', 'small-stat-1k', 'small-read-1k', 'small-delete-1k', 'small-readdir-1k',
  'small-create-10k', 'small-stat-10k', 'small-readdir-10k',
  'archive-extract-300-files',
  'npmlike-install-write', 'npmlike-resolve-probe',
  'git-init', 'git-add-120', 'git-commit', 'git-status-clean',
  'rename-file', 'rename-file-4MiB', 'rename-directory',
] as const;

export function renderMarkdown(artifact: RunArtifact): string {
  const lines: string[] = [];
  const aggregates: LayoutAggregates = new Map();
  for (const layout of artifact.layouts) aggregates.set(layout.id, aggregate(layout.reps));
  const control = aggregates.get('native');

  lines.push('## R2-backed workspace layouts');
  lines.push('');
  lines.push(
    `Measured ${artifact.startedAt.slice(0, 10)} on a real Cloudflare container, `
    + `${artifact.repetitions} repetition${artifact.repetitions === 1 ? '' : 's'} per arm, seed `
    + `${artifact.seed}. Run id \`${artifact.runId}\`.`,
  );
  lines.push('');
  lines.push('### What was run');
  lines.push('');
  for (const [key, value] of Object.entries(artifact.versions)) lines.push(`- ${key}: \`${value}\``);
  lines.push(`- mode: \`${artifact.mode}\``);
  lines.push(`- bucket: \`${artifact.bucket}\`, every object under \`${artifact.keyPrefix}\``);
  lines.push('');
  lines.push('Container facts, as the container reported them:');
  lines.push('');
  lines.push('```');
  lines.push(artifact.containerFacts.trim());
  lines.push('```');
  lines.push('');
  if (artifact.conditions.length > 0) {
    lines.push('Conditions that bound how far these numbers travel:');
    lines.push('');
    for (const condition of artifact.conditions) lines.push(`- ${condition}`);
    lines.push('');
  }

  lines.push('### The four arms');
  lines.push('');
  lines.push('| arm | what it is | question it answers |');
  lines.push('| --- | --- | --- |');
  for (const layout of artifact.layouts) {
    lines.push(`| \`${layout.id}\` | ${layout.label} | ${layout.question} |`);
  }
  lines.push('');

  lines.push('### Mount cost, R2 operations, and what each arm left behind');
  lines.push('');
  lines.push(
    '| arm | mount cold (ms) | mount warm (ms) | R2 class A | R2 class B | R2 free | objects | MiB stored |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const layout of artifact.layouts) {
    const mib = layout.bytesAfter === null ? null : layout.bytesAfter / (1024 * 1024);
    lines.push(
      `| \`${layout.id}\` | ${cell(layout.mountColdMs, 0)} | ${cell(layout.mountWarmMs, 0)} `
      + `| ${cell(layout.ops?.classA ?? null, 0)} | ${cell(layout.ops?.classB ?? null, 0)} `
      + `| ${cell(layout.ops?.classFree ?? null, 0)} `
      + `| ${cell(layout.objectsAfter, 0)} | ${cell(mib, 1)} |`,
    );
  }
  lines.push('');

  lines.push('### Latency and throughput');
  lines.push('');
  lines.push(
    'Each cell is the median of the per-repetition medians, with the median of the '
    + 'per-repetition p95s beside it, in milliseconds. `!` marks an arm whose '
    + 'across-repetition coefficient of variation exceeds 0.25, which means the '
    + 'repetitions did not agree and the value should not be ranked against another arm.',
  );
  lines.push('');
  const header = ['metric', ...artifact.layouts.map((l) => `\`${l.id}\` p50 / p95`)];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const metric of HEADLINE_METRICS) {
    const cells = artifact.layouts.map((layout) => {
      const found = aggregates.get(layout.id)?.get(metric);
      if (found === undefined) return '—';
      const flag = found.unstable ? ' !' : '';
      return `${num(found.acrossReps.p50)} / ${num(found.p95OfReps)}${flag}`;
    });
    if (cells.every((c) => c === '—')) continue;
    lines.push(`| \`${metric}\` | ${cells.join(' | ')} |`);
  }
  lines.push('');

  lines.push('Throughput, MiB/s, median across repetitions:');
  lines.push('');
  const thHeader = ['metric', ...artifact.layouts.map((l) => `\`${l.id}\``)];
  lines.push(`| ${thHeader.join(' | ')} |`);
  lines.push(`| ${thHeader.map(() => '---').join(' | ')} |`);
  for (const metric of ['write-1MiB', 'write-10MiB', 'write-100MiB', 'read-1MiB', 'read-10MiB', 'read-100MiB', 'reread-10MiB']) {
    const cells = artifact.layouts.map((layout) => {
      const found = aggregates.get(layout.id)?.get(metric);
      return found?.throughputMiBs === null || found === undefined ? '—' : num(found.throughputMiBs);
    });
    if (cells.every((c) => c === '—')) continue;
    lines.push(`| \`${metric}\` | ${cells.join(' | ')} |`);
  }
  lines.push('');

  if (control !== undefined) {
    lines.push('Slowdown against the native control, median p50 ratio. Higher is worse:');
    lines.push('');
    const sdHeader = ['metric', ...artifact.layouts.filter((l) => l.id !== 'native').map((l) => `\`${l.id}\``)];
    lines.push(`| ${sdHeader.join(' | ')} |`);
    lines.push(`| ${sdHeader.map(() => '---').join(' | ')} |`);
    for (const metric of HEADLINE_METRICS) {
      const base = control.get(metric)?.acrossReps.p50;
      if (base === undefined || base <= 0) continue;
      const cells = artifact.layouts.filter((l) => l.id !== 'native').map((layout) => {
        const found = aggregates.get(layout.id)?.get(metric);
        if (found === undefined || found.acrossReps.p50 <= 0) return '—';
        return `${num(found.acrossReps.p50 / base, 1)}x`;
      });
      if (cells.every((c) => c === '—')) continue;
      lines.push(`| \`${metric}\` | ${cells.join(' | ')} |`);
    }
    lines.push('');
  }

  lines.push('### CPU, per arm');
  lines.push('');
  lines.push('| arm | user CPU (ms) | system CPU (ms) | wall (ms) | CPU / wall |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const layout of artifact.layouts) {
    let user = 0;
    let system = 0;
    let wall = 0;
    for (const run of layout.reps) {
      for (const phase of run.phases) {
        user += phase.cpuUserMs;
        system += phase.cpuSystemMs;
        wall += phase.wallMs;
      }
    }
    const reps = Math.max(1, layout.reps.length);
    const ratio = wall > 0 ? (user + system) / wall : 0;
    lines.push(
      `| \`${layout.id}\` | ${num(user / reps, 0)} | ${num(system / reps, 0)} `
      + `| ${num(wall / reps, 0)} | ${num(ratio, 2)} |`,
    );
  }
  lines.push('');
  lines.push(
    'A CPU/wall ratio well under 1 on an R2 arm is the measurement saying the arm is '
    + 'waiting on the network, not on the CPU — which is what decides whether a bigger '
    + 'instance type would help. Child processes are included: `tar` and `git` dominate '
    + 'three of the phases, and self-only accounting would report those phases as free.',
  );
  lines.push('');

  lines.push('### POSIX semantics');
  lines.push('');
  lines.push(
    'Each row is an invariant probed on the live filesystem. `held/of` counts the '
    + 'repetitions in which it held: anything other than all or nothing means the '
    + 'behaviour is not deterministic, which for a filesystem is itself the finding.',
  );
  lines.push('');
  const posixHeader = ['invariant', ...artifact.layouts.map((l) => `\`${l.id}\``)];
  lines.push(`| ${posixHeader.join(' | ')} |`);
  lines.push(`| ${posixHeader.map(() => '---').join(' | ')} |`);
  const names = new Set<string>();
  const tables = new Map<LayoutId, Map<string, { held: number; of: number; detail: string }>>();
  for (const layout of artifact.layouts) {
    const rows = new Map<string, { held: number; of: number; detail: string }>();
    for (const row of verdictTable(layout.reps)) {
      rows.set(row.name, row);
      names.add(row.name);
    }
    tables.set(layout.id, rows);
  }
  for (const name of [...names].sort()) {
    const cells = artifact.layouts.map((layout) => {
      const row = tables.get(layout.id)?.get(name);
      if (row === undefined) return '—';
      if (row.held === row.of) return `yes ${row.held}/${row.of}`;
      if (row.held === 0) return `**no** 0/${row.of}`;
      return `**flaky** ${row.held}/${row.of}`;
    });
    lines.push(`| \`${name}\` | ${cells.join(' | ')} |`);
  }
  lines.push('');
  const failures: string[] = [];
  for (const layout of artifact.layouts) {
    for (const row of verdictTable(layout.reps)) {
      if (row.held < row.of) failures.push(`\`${layout.id}\` / \`${row.name}\`: ${row.detail}`);
    }
  }
  if (failures.length > 0) {
    lines.push('What the failures actually said:');
    lines.push('');
    for (const failure of failures) lines.push(`- ${failure}`);
    lines.push('');
  }

  lines.push('### Restart durability');
  lines.push('');
  lines.push('| arm | manifest survived | restart (ms) | detail |');
  lines.push('| --- | --- | --- | --- |');
  for (const layout of artifact.layouts) {
    if (layout.durability === null) {
      lines.push(`| \`${layout.id}\` | — | — | not exercised |`);
      continue;
    }
    lines.push(
      `| \`${layout.id}\` | ${layout.durability.verdict ? 'yes' : '**no**'} `
      + `| ${num(layout.durability.restartMs, 0)} | ${layout.durability.detail} |`,
    );
  }
  lines.push('');

  const synced = artifact.layouts.flatMap(
    (layout) => (layout.sync === null ? [] : [{ id: layout.id, sync: layout.sync }]),
  );
  if (synced.length > 0) {
    lines.push('### Explicit sync, for the overlay arm');
    lines.push('');
    for (const { id, sync } of synced) {
      lines.push(`\`${id}\`:`);
      lines.push('');
      lines.push(`- implementation: ${sync.implementation}`);
      if (sync.error !== null) lines.push(`- error: ${sync.error}`);
      for (const measurement of sync.measurements) {
        lines.push(
          `- ${measurement.name}: `
          + `${measurement.kind === 'count' ? num(measurement.count) : measurement.note}`,
        );
      }
      lines.push('');
    }
  }

  const arms = artifact.layouts.filter((l) => l.mountError !== null);
  if (arms.length > 0) {
    lines.push('### Arms that refused');
    lines.push('');
    for (const layout of arms) lines.push(`- \`${layout.id}\`: ${layout.mountError}`);
    lines.push('');
  }

  lines.push('### The option sets, exactly');
  lines.push('');
  lines.push('Applied by the SDK when the caller passes nothing, and therefore what the uncached arm IS:');
  lines.push('');
  lines.push('```');
  lines.push(SDK_DEFAULT_R2_S3FS_OPTIONS.join('\n'));
  lines.push('```');
  lines.push('');
  lines.push('The tuned arm:');
  lines.push('');
  lines.push('```');
  lines.push(TUNED_S3FS_OPTIONS.join('\n'));
  lines.push('```');
  lines.push('');
  lines.push(
    `Forced by the SDK after the caller's options and therefore not tunable: `
    + `${SDK_FORCED_S3FS_OPTIONS.map((o) => `\`${o}\``).join(', ')}. Refused outright: `
    + `\`passwd_file\`, \`url\`.`,
  );
  lines.push('');
  lines.push('Considered and rejected:');
  lines.push('');
  lines.push('| option | why not |');
  lines.push('| --- | --- |');
  for (const rejected of REJECTED_S3FS_OPTIONS) {
    lines.push(`| \`${rejected.option}\` | ${rejected.reason} |`);
  }
  lines.push('');

  lines.push('### Teardown');
  lines.push('');
  for (const [key, value] of Object.entries(artifact.teardown)) lines.push(`- ${key}: ${String(value)}`);
  lines.push('');

  lines.push('### Recommendation');
  lines.push('');
  lines.push(recommend(artifact, aggregates));
  lines.push('');
  return lines.join('\n');
}

/**
 * The verdict, derived from the numbers rather than written beside them.
 *
 * Three candidate shapes were on the table — R2 as the primary filesystem, R2 as
 * a cold tier under a native cache, and snapshot/CAS with no R2 in the hot path.
 * This picks between them from the measured small-file and metadata costs,
 * because that is what a workspace does: a workspace is not a video store, it is
 * ten thousand small files being stat'd by a toolchain.
 */
export function recommend(
  artifact: RunArtifact,
  aggregates: LayoutAggregates,
): string {
  const native = aggregates.get('native');
  const uncached = aggregates.get('r2-uncached');
  const tuned = aggregates.get('r2-tuned');
  const overlay = aggregates.get('overlay');
  if (native === undefined) {
    return 'No native control completed, so no arm has a denominator and no recommendation is '
      + 'derivable from this run.';
  }

  const ratio = (side: Map<string, MetricAggregate> | undefined, metric: string): number | null => {
    const base = native.get(metric)?.acrossReps.p50;
    const other = side?.get(metric)?.acrossReps.p50;
    if (base === undefined || other === undefined || base <= 0 || other <= 0) return null;
    return other / base;
  };

  const parts: string[] = [];
  const statRatio = ratio(uncached, 'small-stat-1k') ?? ratio(uncached, 'small-stat-10k');
  const tunedStatRatio = ratio(tuned, 'small-stat-1k') ?? ratio(tuned, 'small-stat-10k');
  const createRatio = ratio(uncached, 'small-create-1k');
  const overlayCreateRatio = ratio(overlay, 'small-create-1k');
  const bigWriteRatio = ratio(uncached, 'write-100MiB') ?? ratio(uncached, 'write-10MiB');

  const posixBroken = new Set<string>();
  for (const layout of artifact.layouts) {
    if (layout.id === 'native') continue;
    for (const row of verdictTable(layout.reps)) {
      if (row.held < row.of) posixBroken.add(row.name);
    }
  }

  if (statRatio !== null) {
    parts.push(
      `Metadata is the deciding cost, not bandwidth: an untuned R2 mount stats a small file `
      + `${num(statRatio, 1)}x slower than the container disk`
      + (tunedStatRatio !== null ? `, and ${num(tunedStatRatio, 1)}x with the tuned option set` : '')
      + (bigWriteRatio !== null ? `, while a large sequential write is only ${num(bigWriteRatio, 1)}x` : '')
      + '.',
    );
  }
  if (posixBroken.size > 0) {
    parts.push(
      `The R2 arms failed ${posixBroken.size} POSIX invariant`
      + `${posixBroken.size === 1 ? '' : 's'} the native control holds `
      + `(${[...posixBroken].sort().map((n) => `\`${n}\``).join(', ')}). A toolchain that relies on `
      + `any of them does not merely run slowly on an R2-primary workspace, it runs incorrectly.`,
    );
  }

  const overlayBeatsFuse = overlayCreateRatio !== null && createRatio !== null
    && overlayCreateRatio < createRatio;
  if (overlayBeatsFuse) {
    parts.push(
      `The overlay arm creates small files ${num(createRatio / overlayCreateRatio, 1)}x faster than `
      + `writing through FUSE, because the writes land on the container disk and only the sync pays `
      + `for R2.`,
    );
  }

  let verdict: string;
  if (statRatio !== null && statRatio > 20 && (tunedStatRatio === null || tunedStatRatio > 5)) {
    verdict =
      'R2-PRIMARY IS REJECTED. Tuning moves the number but not the order of magnitude, and the '
      + 'failures above are semantic rather than slow. Use R2 as the durable tier behind a native '
      + 'writable layer: a read-only R2 lower with a container-disk upper and an explicit sync, or '
      + 'snapshot/CAS, whichever the sync column below justifies. The hot path must be the '
      + 'container disk.';
  } else if (statRatio !== null && statRatio <= 20 && posixBroken.size === 0) {
    verdict =
      'R2-PRIMARY IS DEFENSIBLE ON THIS EVIDENCE, with the tuned option set and not the defaults. '
      + 'It held every POSIX invariant the control held and stayed within one order of magnitude on '
      + 'metadata. Re-measure before relying on it: this is the arm most sensitive to region and to '
      + 'the number of files in the tree.';
  } else {
    verdict =
      'NO ARM IS RECOMMENDED FROM THIS RUN. The evidence needed to separate them is missing or the '
      + 'repetitions did not agree; the tables above say which. Treat this as an instrument that '
      + 'now works rather than as a decision.';
  }

  const unstable = [...aggregates.entries()]
    .flatMap(([id, metrics]) => [...metrics.values()].filter((m) => m.unstable).map((m) => `${id}/${m.name}`));
  if (unstable.length > 0) {
    parts.push(
      `${unstable.length} metric-arm pair${unstable.length === 1 ? '' : 's'} exceeded the dispersion `
      + `threshold and are marked \`!\` above. They are not ranked.`,
    );
  }

  return [verdict, ...parts].join(' ');
}
