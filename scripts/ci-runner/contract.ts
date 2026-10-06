/**
 * What `scripts/ci-remote.ts` and the `kinu-ci-runner` Worker agree on: the request that starts a run, the plan the
 * commit's own ladder cuts, the inputs an environment snapshot is keyed by, and the timing history the next plan is
 * sized from. Plain TypeScript, so both the Bun script and the Worker compile it.
 */
import * as v from 'valibot';

export const Sha = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u));

/** Bump when the preparation scripts change what an environment holds: every key changes with it. */
export const PREPARATION = 1;

/** A tree's install inputs by git object id: what `bun install` and its `prepare` hook read. */
export const ManifestSchema = v.pipe(v.array(v.object({ path: v.string(), id: Sha })), v.minLength(1));

export type Manifest = v.InferOutput<typeof ManifestSchema>;

/** What a run's pack is relative to: `root`, the commit's whole history, or the environment's commit, whose history
 *  the snapshot holds. The ladder's history rows (commit hygiene, the history corpus) read the whole of it, as a
 *  GitHub runner's `fetch-depth: 0` checkout gives them. */
export const PackBase = v.union([v.literal('root'), Sha]);

export const StartSchema = v.object({
  sha: Sha,
  base: PackBase,
  manifest: ManifestSchema,
  /** Seconds a source part is cut to; the longest unsplit row is the floor whatever this says. */
  target: v.optional(v.pipe(v.number(), v.integer(), v.minValue(60)), 300),
  label: v.optional(v.pipe(v.string(), v.maxLength(200)), ''),
});

export type StartRequest = v.InferOutput<typeof StartSchema>;

/** `bun scripts/ladder.ts --ci-plan`: the parts, each split suite's files, and each run's label. */
export const PlanSchema = v.object({
  width: v.pipe(v.number(), v.integer(), v.minValue(1)),
  parts: v.pipe(v.array(v.object({ name: v.string(), runs: v.array(v.string()) })), v.minLength(1)),
  split: v.array(v.object({ run: v.string(), files: v.array(v.string()) })),
  labels: v.record(v.string(), v.string()),
});

export type Plan = v.InferOutput<typeof PlanSchema>;

/** The timings a graded run reports back: each green row's seconds by label, and each file's. */
export const TimingsSchema = v.object({
  sha: Sha,
  runId: v.string(),
  seconds: v.record(v.string(), v.number()),
  files: v.record(v.string(), v.number()),
});

export type Timings = v.InferOutput<typeof TimingsSchema>;

/** An environment snapshot: what every shard of every run with its install inputs starts from. */
export const GenerationSchema = v.object({
  key: v.string(),
  snapshot: v.object({ id: v.string(), size: v.number(), name: v.optional(v.string()) }),
  /** The commit whose install it holds. */
  sha: Sha,
  created: v.number(),
  /** Seconds each preparation phase took. */
  seconds: v.record(v.string(), v.number()),
  /** What the install's smoke printed: bun, workerd, Chrome and ffmpeg. */
  versions: v.string(),
});

export type Generation = v.InferOutput<typeof GenerationSchema>;

/** When each step of a piece happened: asked for, the container's first answer, the commit in, the ladder started. */
const ShardTimesSchema = v.object({ requested: v.number(), answered: v.number(), received: v.number(), launched: v.number() });

export type ShardTimes = v.InferOutput<typeof ShardTimesSchema>;

const ShardResultSchema = v.object({
  /** The ladder's exit code: a part's is non-zero when a row was red. */
  exitCode: v.number(),
  /** The R2 key of what it produced: the plan, or the part's verdict file. */
  outputKey: v.string(),
  logKey: v.string(),
  times: ShardTimesSchema,
  finishedAt: v.number(),
});

export type ShardResult = v.InferOutput<typeof ShardResultSchema>;

const PhaseSchema = v.picklist(['preparing', 'planning', 'running', 'settling', 'done']);

export type Phase = v.InferOutput<typeof PhaseSchema>;

/** The plan, or one CI part: its current attempt and what that attempt has said. */
const PieceRowSchema = v.object({
  name: v.string(),
  attempt: v.number(),
  state: v.picklist(['booting', 'running', 'done', 'infra-failed', 'stopped']),
  updatedAt: v.number(),
  errors: v.array(v.string()),
  progress: v.string(),
  result: v.nullable(ShardResultSchema),
});

export type PieceRow = v.InferOutput<typeof PieceRowSchema>;

const RunSpecSchema = v.object({ ...StartSchema.entries, runId: v.string(), key: v.string(), createdAt: v.number() });

export type RunSpec = v.InferOutput<typeof RunSpecSchema>;

export const RunStatusSchema = v.object({
  spec: RunSpecSchema,
  phase: PhaseSchema,
  /** `pass` and `fail` read the parts' exit codes; only the collected verdict files grade the commit. */
  verdict: v.nullable(v.picklist(['pass', 'fail', 'error'])),
  problems: v.array(v.string()),
  environment: v.nullable(GenerationSchema),
  plan: v.nullable(PieceRowSchema),
  parts: v.array(PieceRowSchema),
  finishedAt: v.nullable(v.number()),
});

export type RunStatus = v.InferOutput<typeof RunStatusSchema>;

/** Paths whose bytes decide what an install leaves in the tree: the lock, the workspaces' manifests, the patches, and
 *  the vendored SDK the `prepare` hook verifies and builds (`scripts/mossaic-sdk.ts`). */
export function installInput(path: string): boolean {
  return /^(bun\.lock|bunfig\.toml|package\.json|packages\/[^/]+\/package\.json|patches\/.+|third_party\/mossaic\/.+|scripts\/mossaic-sdk\.ts)$/u.test(path);
}

/** One environment per set of install inputs and preparation scripts. */
export async function environmentKey(manifest: Manifest): Promise<string> {
  const entries = [...manifest].sort((left, right) => left.path.localeCompare(right.path)).map((entry) => `${entry.path} ${entry.id}`);
  const bytes = new TextEncoder().encode(JSON.stringify([PREPARATION, entries]));

  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The samples a planning estimate keeps per row or file. */
export const SAMPLES = 5;

/** Each key's last `SAMPLES` measurements, the newest last. */
export function recordSamples(history: Readonly<Record<string, readonly number[]>>, sample: Readonly<Record<string, number>>): Record<string, number[]> {
  const next: Record<string, number[]> = Object.fromEntries(Object.entries(history).map(([key, values]) => [key, [...values]]));

  for (const [key, seconds] of Object.entries(sample)) next[key] = [...next[key] ?? [], seconds].slice(-SAMPLES);

  return next;
}

/** The median of each key's samples: one slow run moves no estimate. */
export function medians(history: Readonly<Record<string, readonly number[]>>): Record<string, number> {
  return Object.fromEntries(Object.entries(history).map(([key, values]) => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);

    return [key, sorted.length % 2 === 1 ? sorted[middle] ?? 0 : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2];
  }));
}
